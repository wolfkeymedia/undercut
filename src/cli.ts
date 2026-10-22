#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { politeFetcher } from "./collectors/http.js";
import { parseCostsCsv } from "./costs.js";
import { buildBrief, checkStore, refreshMatches, storeIdFromUrl } from "./pipeline.js";
import { migrate, PostgresRepository } from "./store/postgres.js";
import type { ProductMatch, Store } from "./types.js";

const HELP = `Usage: undercut <command> [options]

Commands:
  migrate                          Create or update the database tables
  add-store <url> --merchant       Add your own store
  add-store <url> [--name NAME]    Add a competitor
  stores                           List stores
  import-costs <file.csv>          Load unit costs for your products (columns: id or url or title, cost)
  run                              Check every store now and refresh product matches
  matches [--status STATUS]        List suggested matches (or confirmed, rejected, all)
  confirm <match-number>...        Confirm matches by the number shown in "matches"
  reject <match-number>...         Reject matches by the number shown in "matches"
  confirm-above <confidence>       Confirm every suggested match at or above a confidence, e.g. 0.8
  brief [--days 7] [--out FILE]    Write the weekly brief

Environment: DATABASE_URL (required), ANTHROPIC_API_KEY (optional, for Claude-written briefs)`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      merchant: { type: "boolean" },
      name: { type: "string" },
      status: { type: "string" },
      days: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Set DATABASE_URL to a Postgres connection string (see .env.example).");
  const repo = PostgresRepository.fromUrl(databaseUrl);

  try {
    switch (command) {
      case "migrate": {
        const applied = await migrate(repo.db);
        console.log(applied.length ? `Applied ${applied.join(", ")}` : "Database is up to date.");
        break;
      }

      case "add-store": {
        const url = args[0];
        if (!url) throw new Error("Give the store's URL, e.g. undercut add-store https://example.com");
        const origin = new URL(url.startsWith("http") ? url : `https://${url}`).origin;
        const kind: Store["kind"] = values.merchant ? "merchant" : "competitor";
        if (kind === "merchant") {
          const existing = await repo.listStores("merchant");
          if (existing.length > 0 && existing[0]!.url !== origin) {
            throw new Error(`Your store is already set to ${existing[0]!.url}. This version supports one merchant store.`);
          }
        }
        const store: Store = { id: storeIdFromUrl(origin), name: values.name ?? new URL(origin).host.replace(/^www\./, ""), url: origin, kind };
        await repo.upsertStore(store);
        console.log(`Added ${kind === "merchant" ? "your store" : "competitor"} ${store.name} (${store.id})`);
        break;
      }

      case "stores": {
        for (const s of await repo.listStores()) console.log(`${s.kind.padEnd(10)} ${s.id.padEnd(30)} ${s.url}`);
        break;
      }

      case "import-costs": {
        const file = args[0];
        if (!file) throw new Error("Give the CSV file path.");
        const [merchant] = await repo.listStores("merchant");
        if (!merchant) throw new Error("Add your store first with: undercut add-store <url> --merchant");
        const products = await repo.currentProducts(merchant.id);
        if (products.length === 0) throw new Error("Run `undercut run` once so your catalog is loaded, then import costs.");
        const { costs, unmatched } = parseCostsCsv(await readFile(file, "utf8"), products);
        await repo.setCosts(merchant.id, costs);
        console.log(`Saved costs for ${costs.size} products.${unmatched.length ? ` No product found for: ${unmatched.join(", ")}` : ""}`);
        break;
      }

      case "run": {
        const fetcher = politeFetcher();
        for (const store of await repo.listStores()) {
          try {
            const { observation, events } = await checkStore(repo, fetcher, store);
            console.log(
              `${store.name}: ${observation.products.length} products via ${observation.source}, ` +
                `${observation.promotions.length} promotions, ${events.length} changes`,
            );
          } catch (err) {
            console.error(`${store.name}: ${(err as Error).message}`);
          }
        }
        const suggested = await refreshMatches(repo);
        console.log(`Product matches suggested or refreshed: ${suggested}`);
        break;
      }

      case "matches":
      case "confirm":
      case "reject": {
        // Confirm and reject use the numbers from the default listing, which shows suggested matches.
        const requested = command === "matches" ? (values.status ?? "suggested") : "suggested";
        const status = requested === "all" ? undefined : (requested as ProductMatch["status"]);
        const matches = await repo.listMatches(status);
        if (command === "matches") {
          const titles = await titleLookup(repo);
          matches.forEach((m, i) => {
            console.log(
              `${String(i + 1).padStart(4)}  ${m.status.padEnd(9)} ${m.confidence.toFixed(2)}  ` +
                `${titles.get(`merchant|${m.merchantExternalId}`) ?? m.merchantExternalId}  <->  ` +
                `${m.competitorStoreId}: ${titles.get(`${m.competitorStoreId}|${m.competitorExternalId}`) ?? m.competitorExternalId}`,
            );
          });
          if (matches.length === 0) console.log("No matches yet. Run `undercut run` first.");
          break;
        }
        for (const n of args.map(Number)) {
          const m = matches[n - 1];
          if (!m) throw new Error(`No suggested match number ${n}. Run \`undercut matches\`.`);
          await repo.setMatchStatus(m, command === "confirm" ? "confirmed" : "rejected");
        }
        console.log(`${command === "confirm" ? "Confirmed" : "Rejected"} ${args.length} matches.`);
        break;
      }

      case "confirm-above": {
        const min = Number(args[0]);
        if (!(min > 0 && min <= 1)) throw new Error("Give a confidence between 0 and 1, e.g. 0.8");
        const matches = (await repo.listMatches("suggested")).filter((m) => m.confidence >= min);
        for (const m of matches) await repo.setMatchStatus(m, "confirmed");
        console.log(`Confirmed ${matches.length} matches at or above ${min}.`);
        break;
      }

      case "brief": {
        const days = Number(values.days ?? 7);
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const { markdown, writer } = await buildBrief(repo, since);
        if (values.out) {
          await writeFile(values.out, markdown + "\n");
          console.log(`Wrote the brief to ${values.out} (${writer === "claude" ? "written by Claude" : "plain template"}).`);
        } else {
          console.log(markdown);
        }
        break;
      }

      default:
        console.log(HELP);
        process.exitCode = 1;
    }
  } finally {
    await repo.close();
  }
}

async function titleLookup(repo: PostgresRepository): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  for (const store of await repo.listStores()) {
    const prefix = store.kind === "merchant" ? "merchant" : store.id;
    for (const p of await repo.currentProducts(store.id)) titles.set(`${prefix}|${p.externalId}`, p.title);
  }
  return titles;
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});

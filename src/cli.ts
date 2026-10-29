#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { politeFetcher } from "./collectors/http.js";
import { browserRenderer } from "./collectors/render.js";
import { sendAlerts } from "./alerts.js";
import { loadConfig } from "./config.js";
import { parseEconomicsCsv } from "./costs.js";
import { recommendationsCsv } from "./insights/pricing.js";
import { formatCents } from "./money.js";
import { buildBrief, buildInsights, checkStore, pairProducts, refreshMatches, storeIdFromUrl } from "./pipeline.js";
import { renderReport } from "./report/html.js";
import { migrate, PostgresRepository } from "./store/postgres.js";
import type { ProductMatch, Store } from "./types.js";

const HELP = `Usage: undercut <command> [options]

Commands:
  migrate                          Create or update the database tables
  add-store <url> --merchant       Add your own store
  add-store <url> [--name NAME]    Add a competitor
  stores                           List stores
  import-products <file.csv>       Load unit costs and weekly unit sales for your products
                                   (columns: id, url or title, plus cost and/or units_per_week)
  run                              Check every store, refresh product matches, send instant alerts
  matches [--status STATUS]        List suggested matches (or confirmed, rejected, all)
  confirm <match-number>...        Confirm matches by the number shown in "matches"
  reject <match-number>...         Reject matches by the number shown in "matches"
  confirm-above <confidence>       Confirm every suggested match at or above a confidence, e.g. 0.8
  pair <your-url> <their-url>      Pair one of your products with an equivalent competitor product by hand
  brief [--days 7] [--out FILE]    Write the weekly brief
  report [--days 7] [--out FILE]   Write the weekly manager report as one HTML page
  scorecard                        Show where each of your products stands against competitors
  prices [--out FILE]              Recommend price changes from your pricing rules (CSV with --out)

Settings: undercut.config.json (see undercut.config.example.json) for pricing rules, alert webhook and estimates.
Environment: DATABASE_URL (required), ANTHROPIC_API_KEY (optional, for Claude-written briefs),
             UNDERCUT_ALERT_WEBHOOK (optional, Slack incoming webhook or any JSON endpoint)`;

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
  const config = await loadConfig();
  const days = Number(values.days ?? 7);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

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
        // Keep a regional path such as /ie: it decides which prices, currency and sitemap we read.
        const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
        const origin = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
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

      case "import-products":
      case "import-costs": {
        const file = args[0];
        if (!file) throw new Error("Give the CSV file path.");
        const [merchant] = await repo.listStores("merchant");
        if (!merchant) throw new Error("Add your store first with: undercut add-store <url> --merchant");
        const products = await repo.currentProducts(merchant.id);
        if (products.length === 0) throw new Error("Run `undercut run` once so your catalog is loaded, then import this file.");
        const { economics, unmatched } = parseEconomicsCsv(await readFile(file, "utf8"), products);
        await repo.setEconomics(merchant.id, economics);
        console.log(`Saved figures for ${economics.size} products.${unmatched.length ? ` No product found for: ${unmatched.join(", ")}` : ""}`);
        break;
      }

      case "run": {
        const runStartedAt = new Date();
        const fetcher = politeFetcher();
        const renderer = config.collect.renderJavaScript === "auto" ? await browserRenderer() : null;
        for (const store of await repo.listStores()) {
          try {
            const { observation, events } = await checkStore(repo, fetcher, store, { renderer });
            console.log(
              `${store.name}: ${observation.products.length} products via ${observation.source}, ` +
                `${observation.promotions.length} promotions, ${events.length} changes`,
            );
          } catch (err) {
            console.error(`${store.name}: ${(err as Error).message}`);
          }
        }
        await renderer?.close();
        const suggested = await refreshMatches(repo);
        console.log(`Product matches suggested or refreshed: ${suggested}`);
        if (config.alerts.webhookUrl && (await repo.listStores("merchant")).length > 0) {
          const insights = await buildInsights(repo, config, runStartedAt);
          const sent = await sendAlerts(insights.items, {
            webhookUrl: config.alerts.webhookUrl,
            minScore: config.alerts.minScore,
            merchantName: insights.merchant.name,
            currency: insights.currency,
          });
          console.log(sent ? `Sent an alert covering ${sent} urgent changes.` : "Nothing urgent to alert on.");
        }
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

      case "pair": {
        const [yourUrl, theirUrl] = args;
        if (!yourUrl || !theirUrl) throw new Error("Give your product's URL, then the competitor product's URL.");
        const renderer = config.collect.renderJavaScript === "auto" ? await browserRenderer() : null;
        const { yours, theirs, competitor } = await pairProducts(repo, politeFetcher(), yourUrl, theirUrl, renderer).finally(() => renderer?.close());
        const money = (c: number) => formatCents(c, yours.currency);
        console.log(`Paired ${yours.title} (${money(yours.priceCents)}) with ${competitor.name}'s ${theirs.title} (${money(theirs.priceCents)}).`);
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
        const { markdown, writer } = await buildBrief(repo, since, new Date(), config);
        if (values.out) {
          await writeFile(values.out, markdown + "\n");
          console.log(`Wrote the brief to ${values.out} (${writer === "claude" ? "written by Claude" : "plain template"}).`);
        } else {
          console.log(markdown);
        }
        break;
      }

      case "report": {
        const insights = await buildInsights(repo, config, since);
        const out = values.out ?? "undercut-report.html";
        await writeFile(out, renderReport(insights, config, { weekOf: since }));
        console.log(`Wrote the report to ${out}. Open it in a browser, or attach it to an email.`);
        break;
      }

      case "scorecard": {
        const { scorecard, currency, headline } = await buildInsights(repo, config, since);
        const money = (c: number) => formatCents(c, currency);
        for (const line of headline) console.log(`• ${line}`);
        console.log("");
        for (const p of scorecard.positions) {
          const r = p.cheapestRival;
          console.log(
            `${p.position.padEnd(17)} ${money(p.product.priceCents).padStart(10)}  ${p.product.title}` +
              (r ? `  |  ${r.storeName} ${money(r.priceCents)} (${r.gapPercent > 0 ? "+" : ""}${r.gapPercent.toFixed(1)}%)` : "") +
              (p.revenueAtRiskCents ? `  |  ${money(p.revenueAtRiskCents)}/wk at risk` : ""),
          );
        }
        if (scorecard.positions.length === 0) console.log("No confirmed matches yet. Review them with `undercut matches`.");
        break;
      }

      case "prices": {
        const { recommendations, currency } = await buildInsights(repo, config, since);
        if (values.out) {
          await writeFile(values.out, recommendationsCsv(recommendations));
          console.log(`Wrote ${recommendations.length} recommended price changes to ${values.out}.`);
          break;
        }
        const money = (c: number) => formatCents(c, currency);
        for (const r of recommendations) {
          console.log(`${r.title}: ${money(r.currentCents)} -> ${money(r.recommendedCents)}. ${r.reason}`);
        }
        if (recommendations.length === 0) console.log("No price changes recommended.");
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

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { politeFetcher, type Fetcher } from "../collectors/http.js";
import { DEFAULT_CONFIG, withClientSettings, type PricingConfig } from "../config.js";
import { parseEconomicsCsv } from "../costs.js";
import { recommendationsCsv } from "../insights/pricing.js";
import { buildInsights, buildMarketView, pairProducts, refreshMatches, storeIdFromUrl } from "../pipeline.js";
import { renderReport } from "../report/html.js";
import { renderMarketReport } from "../report/market.js";
import { authorizeUrl, exchangeCode, normaliseShop, verifyQueryHmac, verifyWebhookHmac } from "../shopify/oauth.js";
import { adminGraphQL, shopInfo } from "../shopify/sync.js";
import { ClientRegistry, type Client, type ClientSettings } from "../store/clients.js";
import { migrate, PostgresRepository } from "../store/postgres.js";
import type { ProductMatch, Store } from "../types.js";
import { checkOneStore, finishClient, syncShopify } from "./jobs.js";
import { cookie, html, HttpError, json, redirect, send, text, toRequest, type Reply, type Request } from "./http.js";
import { randomToken, safeEqual, Secrets } from "./secrets.js";
import { clientPage, dashboardPage, loginPage, notFoundPage, setupPage, waitingPage, type ClientRow } from "./views.js";

/**
 * The hosted app: admin pages to set up clients, a private report link per client,
 * the daily scheduled checks, and the Shopify read-only install.
 */

export interface AppEnv {
  DATABASE_URL?: string;
  /** Set by Vercel's Postgres integrations (Neon, Supabase); used when DATABASE_URL isn't. */
  POSTGRES_URL?: string;
  UNDERCUT_SECRET?: string;
  ADMIN_PASSWORD?: string;
  CRON_SECRET?: string;
  SHOPIFY_API_KEY?: string;
  SHOPIFY_API_SECRET?: string;
  UNDERCUT_PUBLIC_URL?: string;
}

/** How long one invocation spends reading product pages, under the 300 s function limit. */
const CHECK_BUDGET_MS = Number(process.env.UNDERCUT_CHECK_BUDGET_MS ?? 230_000);
/** A large store continues in up to this many follow-up invocations per day. */
const MAX_ROUNDS = 6;
const ADMIN_COOKIE = "uc_admin";
const STATE_COOKIE = "uc_shopify_state";
const DAY = 86_400_000;

interface Context {
  env: AppEnv;
  root: PostgresRepository;
  registry: ClientRegistry;
  secrets: Secrets;
  /** Starts work that outlives the response (Vercel keeps the function alive for it). */
  background: (work: Promise<unknown>) => void;
  /** Calls this app's own endpoint, e.g. to check a store in its own invocation. */
  dispatch: (baseUrl: string, path: string) => Promise<void>;
  /** Reads store pages; tests pass a fake one. */
  fetcher?: Fetcher;
}

type Overrides = Partial<Pick<Context, "background" | "dispatch" | "fetcher">>;

let shared: { url: string; root: PostgresRepository; ready: Promise<unknown> } | null = null;

function database(url: string) {
  if (!shared || shared.url !== url) {
    // Serverless: few connections per instance; use a pooled connection string (e.g. Supabase port 6543).
    const root = PostgresRepository.fromUrl(url, undefined, { max: 3, idleTimeoutMillis: 10_000, ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined });
    shared = { url, root, ready: migrate(root.db) };
    shared.ready.catch(() => (shared = null));
  }
  return shared;
}

function needsSsl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return !["localhost", "127.0.0.1"].includes(host) && !/sslmode=disable/.test(url);
  } catch {
    return false;
  }
}

export function createApp(env: AppEnv = process.env as AppEnv, overrides: Overrides = {}) {
  return async function handler(req: IncomingMessage, res: ServerResponse) {
    let reply: Reply;
    try {
      reply = await route(toRequest(req, env.UNDERCUT_PUBLIC_URL), env, overrides);
    } catch (err) {
      if (err instanceof HttpError) reply = html(notFoundPage(), err.status);
      else {
        console.error(err);
        reply = text("Something went wrong. Please try again in a minute.", 500);
      }
    }
    send(res, reply);
  };
}

async function route(req: Request, rawEnv: AppEnv, overrides: Overrides): Promise<Reply> {
  const env = { ...rawEnv, DATABASE_URL: rawEnv.DATABASE_URL || rawEnv.POSTGRES_URL };
  if (req.path === "/healthz") return json({ ok: true });
  if (req.path === "/robots.txt") return text("User-agent: *\nDisallow: /\n");

  const missing = (["DATABASE_URL", "UNDERCUT_SECRET", "ADMIN_PASSWORD", "CRON_SECRET"] as const).filter((k) => !env[k]);
  if (missing.length > 0) return html(setupPage([...missing]), 503);

  const db = database(env.DATABASE_URL!);
  await db.ready;
  const ctx: Context = {
    env,
    root: db.root,
    registry: new ClientRegistry(db.root.db),
    secrets: new Secrets(env.UNDERCUT_SECRET!),
    background: overrides.background ?? ((work) => waitUntil(work.catch((err) => console.error(err)))),
    dispatch:
      overrides.dispatch ??
      (async (baseUrl, path) => {
        const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${env.CRON_SECRET}` }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok && res.status !== 202) throw new Error(`${path} returned HTTP ${res.status}`);
      }),
    fetcher: overrides.fetcher,
  };

  const p = req.path;
  let m: RegExpMatchArray | null;

  // Client report links: no account needed, the token in the link is the key.
  if ((m = p.match(/^\/r\/([a-f0-9]+)(?:\/(market|prices\.csv))?$/))) return report(ctx, req, m[1]!, m[2]);

  // Scheduled and internal jobs.
  if (p === "/api/cron/collect") return cronAuth(ctx, req) ?? collectAll(ctx, req);
  if (p === "/api/cron/finish") return cronAuth(ctx, req) ?? finishAll(ctx);
  if (p === "/api/check") return cronAuth(ctx, req) ?? checkJob(ctx, req);

  // Shopify.
  if (p === "/shopify/install") return shopifyInstall(ctx, req);
  if (p === "/shopify/callback") return shopifyCallback(ctx, req);
  if (p === "/shopify/webhooks") return shopifyWebhook(ctx, req);

  // Admin.
  if (p === "/login" && req.method === "POST") return login(ctx, req);
  if (p === "/login") return html(loginPage());
  if (p === "/logout") return redirect("/login", { "set-cookie": cookie(ADMIN_COOKIE, "", { maxAge: 0, secure: secure(req) }) });
  if (!isAdmin(ctx, req)) return req.method === "GET" ? redirect("/login") : text("Sign in first", 401);

  const flash = { notice: req.query.get("ok"), error: req.query.get("error") };
  if (p === "/" && req.method === "GET") return dashboard(ctx, req, flash);
  if (p === "/clients" && req.method === "POST") return createClient(ctx, req);
  if ((m = p.match(/^\/clients\/([a-z0-9-]+)(\/.*)?$/))) {
    const client = await ctx.registry.get(m[1]!);
    if (!client) throw new HttpError(404, "No such client");
    return clientRoutes(ctx, req, client, m[2] ?? "", flash);
  }
  throw new HttpError(404, "Not found");
}

// ---------- auth ----------

const secure = (req: Request) => req.baseUrl.startsWith("https://");

function isAdmin(ctx: Context, req: Request): boolean {
  const value = ctx.secrets.unsign(req.cookies.get(ADMIN_COOKIE));
  if (!value) return false;
  const [who, expires, passwordTag] = value.split(":");
  // Changing ADMIN_PASSWORD signs everyone out.
  return who === "admin" && Number(expires) > Date.now() && passwordTag === passwordFingerprint(ctx.env.ADMIN_PASSWORD!);
}

const passwordFingerprint = (pw: string) => createHash("sha256").update(`admin-password:${pw}`).digest("hex").slice(0, 12);

async function login(ctx: Context, req: Request): Promise<Reply> {
  const form = await req.form();
  const given = createHash("sha256").update(form.get("password") ?? "").digest("hex");
  const expected = createHash("sha256").update(ctx.env.ADMIN_PASSWORD!).digest("hex");
  if (!safeEqual(given, expected)) return html(loginPage("That password isn't right."), 401);
  const days = 30;
  const value = ctx.secrets.sign(`admin:${Date.now() + days * DAY}:${passwordFingerprint(ctx.env.ADMIN_PASSWORD!)}`);
  return redirect("/", { "set-cookie": cookie(ADMIN_COOKIE, value, { maxAge: days * 86400, secure: secure(req) }) });
}

/** Vercel cron sends "Authorization: Bearer $CRON_SECRET"; internal job calls send the same. */
function cronAuth(ctx: Context, req: Request): Reply | null {
  const header = String(req.headers.authorization ?? "");
  return safeEqual(header, `Bearer ${ctx.env.CRON_SECRET}`) ? null : json({ error: "unauthorised" }, 401);
}

// ---------- jobs ----------

async function collectAll(ctx: Context, req: Request): Promise<Reply> {
  const stores = await ctx.registry.storesToCheck();
  const results = await Promise.allSettled(stores.map((s) => ctx.dispatch(req.baseUrl, `/api/check?store=${encodeURIComponent(s.id)}&round=1`)));
  const failed = results.filter((r) => r.status === "rejected").length;
  return json({ dispatched: stores.length - failed, failed });
}

async function checkJob(ctx: Context, req: Request): Promise<Reply> {
  const storeId = req.query.get("store");
  const round = Number(req.query.get("round") ?? 1);
  if (!storeId) return json({ error: "store is required" }, 400);
  // Answer at once and do the work in the background, so the caller isn't held for minutes.
  ctx.background(
    (async () => {
      const result = await checkOneStore(ctx.root, ctx.registry, storeId, { budgetMs: CHECK_BUDGET_MS, fetcher: ctx.fetcher });
      console.log(JSON.stringify({ job: "check", round, ...result }));
      if (!result.complete && round < MAX_ROUNDS) {
        await ctx.dispatch(req.baseUrl, `/api/check?store=${encodeURIComponent(storeId)}&round=${round + 1}`);
      }
    })(),
  );
  return json({ accepted: storeId, round }, 202);
}

async function finishAll(ctx: Context): Promise<Reply> {
  const since = new Date(Date.now() - DAY);
  const results = [];
  for (const client of (await ctx.registry.list()).filter((c) => c.active)) {
    results.push(await finishClient(ctx.root, ctx.registry, ctx.secrets, client, since));
  }
  console.log(JSON.stringify({ job: "finish", results }));
  return json({ clients: results });
}

// ---------- reports ----------

async function report(ctx: Context, req: Request, token: string, view?: string): Promise<Reply> {
  const client = await ctx.registry.byReportToken(token);
  if (!client) throw new HttpError(404, "No such report");
  const repo = ctx.root.forClient(client.id);
  const config = withClientSettings(DEFAULT_CONFIG, client.settings);
  const days = Math.min(90, Math.max(1, Number(req.query.get("days") ?? 7) || 7));
  const since = new Date(Date.now() - days * DAY);
  const stores = await repo.listStores();
  const merchant = stores.find((s) => s.kind === "merchant");
  const status = await ctx.registry.storeStatus(stores.map((s) => s.id));
  if (![...status.values()].some((s) => s.products > 0)) return html(waitingPage(client.name));

  const base = `/r/${client.reportToken}`;
  const nav = (current: "report" | "market") =>
    `<nav style="max-width:1080px;margin:0 auto;padding:12px 16px 0;font:14px system-ui,sans-serif;display:flex;gap:16px;flex-wrap:wrap">` +
    (merchant ? `<a href="${base}"${current === "report" ? ' style="font-weight:700"' : ""}>Weekly report</a>` : "") +
    `<a href="${base}/market"${current === "market" ? ' style="font-weight:700"' : ""}>Market view</a>` +
    (merchant ? `<a href="${base}/prices.csv">Price changes (CSV)</a>` : "") +
    `</nav>`;
  const withNav = (doc: string, current: "report" | "market") => doc.replace("<body>", `<body>${nav(current)}`);
  const headers = { "x-robots-tag": "noindex", "referrer-policy": "no-referrer" };

  if (view === "prices.csv") {
    if (!merchant) throw new HttpError(404, "No store of their own yet");
    const { recommendations } = await buildInsights(repo, config, since);
    return text(recommendationsCsv(recommendations), 200, "text/csv; charset=utf-8", {
      "content-disposition": `attachment; filename="${client.id}-price-changes.csv"`,
    });
  }
  if (view === "market" || !merchant) {
    const market = await buildMarketView(repo, since);
    return html(withNav(renderMarketReport(market, { since, title: merchant ? `${merchant.name} against the market` : `${client.name}: competitor market` }), "market"), 200, headers);
  }
  const insights = await buildInsights(repo, config, since);
  return html(withNav(renderReport(insights, config, { weekOf: since }), "report"), 200, headers);
}

// ---------- admin ----------

async function dashboard(ctx: Context, req: Request, flash: { notice: string | null; error: string | null }): Promise<Reply> {
  const rows: ClientRow[] = [];
  for (const client of await ctx.registry.list()) {
    const repo = ctx.root.forClient(client.id);
    const stores = await repo.listStores();
    const status = await ctx.registry.storeStatus(stores.map((s) => s.id));
    const checked = [...status.values()].map((s) => s.lastCheckedAt?.getTime() ?? 0);
    rows.push({
      client,
      merchant: stores.find((s) => s.kind === "merchant"),
      competitors: stores.filter((s) => s.kind === "competitor").length,
      confirmedPairs: (await repo.listMatches("confirmed")).length,
      lastCheckedAt: checked.length && Math.max(...checked) > 0 ? new Date(Math.max(...checked)) : undefined,
    });
  }
  return html(dashboardPage(rows, req.baseUrl, flash));
}

function storeFromInput(raw: string, kind: Store["kind"], name?: string): Store {
  const parsed = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname.includes(".")) throw new Error(`${raw} is not a store address`);
  // Keep a regional path such as /ie: it decides which prices, currency and sitemap we read.
  const url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  return { id: storeIdFromUrl(url) + (parsed.pathname.length > 1 ? parsed.pathname.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/-+$/, "") : ""), name: name?.trim() || parsed.hostname.replace(/^www\./, ""), url, kind };
}

async function startChecks(ctx: Context, req: Request, storeIds: string[]) {
  ctx.background(Promise.allSettled(storeIds.map((id) => ctx.dispatch(req.baseUrl, `/api/check?store=${encodeURIComponent(id)}&round=1`))));
}

async function createClient(ctx: Context, req: Request): Promise<Reply> {
  const form = await req.form();
  const name = (form.get("name") ?? "").trim();
  if (!name) return redirect(`/?error=${encodeURIComponent("Give the business a name.")}`);
  const stores: Store[] = [];
  try {
    const own = (form.get("store") ?? "").trim();
    if (own) stores.push(storeFromInput(own, "merchant"));
    for (const line of (form.get("competitors") ?? "").split(/\r?\n/)) {
      if (line.trim()) stores.push(storeFromInput(line, "competitor"));
    }
  } catch (err) {
    return redirect(`/?error=${encodeURIComponent((err as Error).message)}`);
  }
  const client = await ctx.registry.create(name);
  const repo = ctx.root.forClient(client.id);
  for (const s of stores) await repo.upsertStore(s);
  await startChecks(ctx, req, stores.map((s) => s.id));
  return redirect(`/clients/${client.id}?ok=${encodeURIComponent(`Added ${client.name}. The first check has started.`)}`);
}

async function clientRoutes(ctx: Context, req: Request, client: Client, sub: string, flash: { notice: string | null; error: string | null }): Promise<Reply> {
  const repo = ctx.root.forClient(client.id);
  const back = (key: "ok" | "error", message: string) => redirect(`/clients/${client.id}?${key}=${encodeURIComponent(message)}`);

  if (sub === "" && req.method === "GET") return html(await renderClient(ctx, req, client, flash));
  if (req.method !== "POST") throw new HttpError(404, "Not found");
  const form = await req.form();
  let m: RegExpMatchArray | null;

  try {
    switch (true) {
      case sub === "/stores": {
        const kind: Store["kind"] = form.get("role") === "merchant" ? "merchant" : "competitor";
        if (kind === "merchant" && (await repo.listStores("merchant")).length > 0) return back("error", "This client already has their own store. Remove it first to change it.");
        const store = storeFromInput(form.get("url") ?? "", kind, form.get("name") ?? undefined);
        await repo.upsertStore(store);
        await startChecks(ctx, req, [store.id]);
        return back("ok", `Added ${store.name}. Its first check has started.`);
      }
      case Boolean((m = sub.match(/^\/stores\/([a-z0-9-]+)\/remove$/))): {
        await repo.removeStore(m![1]!);
        return back("ok", "Store removed.");
      }
      case sub === "/check": {
        const stores = await repo.listStores();
        await startChecks(ctx, req, stores.map((s) => s.id));
        return back("ok", `Checking ${stores.length} stores. Large stores take a few minutes; refresh this page to see progress.`);
      }
      case sub === "/matches": {
        const [merchantExternalId, competitorStoreId, competitorExternalId] = JSON.parse(form.get("key") ?? "[]") as string[];
        const status = form.get("status") as ProductMatch["status"];
        if (!merchantExternalId || !competitorStoreId || !competitorExternalId || !["confirmed", "rejected"].includes(status)) throw new Error("That pair wasn't recognised.");
        await repo.setMatchStatus({ merchantExternalId, competitorStoreId, competitorExternalId }, status);
        return back("ok", status === "confirmed" ? "Pair confirmed." : "Pair rejected.");
      }
      case sub === "/confirm-above": {
        const min = Number(form.get("min"));
        if (!(min >= 0.5 && min <= 1)) throw new Error("Pick a confidence between 0.5 and 1.");
        const matches = (await repo.listMatches("suggested")).filter((x) => x.confidence >= min);
        for (const x of matches) await repo.setMatchStatus(x, "confirmed");
        return back("ok", `Confirmed ${matches.length} pairs.`);
      }
      case sub === "/pair": {
        const { yours, theirs, competitor } = await pairProducts(repo, ctx.fetcher ?? politeFetcher(), form.get("yours") ?? "", form.get("theirs") ?? "");
        return back("ok", `Paired ${yours.title} with ${competitor.name}'s ${theirs.title}.`);
      }
      case sub === "/settings": {
        const num = (k: string) => (form.get(k) === null || form.get(k) === "" ? undefined : Number(form.get(k)));
        const strategy = form.get("strategy") as PricingConfig["strategy"];
        const rounding = form.get("rounding") as PricingConfig["rounding"];
        const webhook = (form.get("webhookUrl") ?? "").trim();
        if (webhook && !/^https:\/\//.test(webhook)) throw new Error("The alert URL must start with https://");
        const settings: ClientSettings = {
          ...client.settings,
          pricing: {
            ...client.settings.pricing,
            ...(["beat", "match", "premium"].includes(strategy) ? { strategy } : {}),
            ...(["match", "99", "95", "none"].includes(rounding) ? { rounding } : {}),
            beatByPercent: num("beatByPercent"),
            premiumPercent: num("premiumPercent"),
            minMarginPercent: num("minMarginPercent"),
            maxChangePercent: num("maxChangePercent"),
          },
          alerts: { ...client.settings.alerts, webhookUrl: webhook || undefined },
        };
        for (const [k, v] of Object.entries(settings.pricing!)) if (v === undefined || Number.isNaN(v)) delete (settings.pricing as Record<string, unknown>)[k];
        await ctx.registry.update(client.id, { name: form.get("name") ?? undefined, settings });
        return back("ok", "Settings saved.");
      }
      case sub === "/economics": {
        const [merchant] = await repo.listStores("merchant");
        if (!merchant) throw new Error("Add the client's own store first.");
        const products = await repo.currentProducts(merchant.id);
        if (products.length === 0) throw new Error("Their store hasn't been checked yet. Try again after the first check.");
        const { economics, unmatched } = parseEconomicsCsv(form.get("csv") ?? "", products);
        await repo.setEconomics(merchant.id, economics);
        return back("ok", `Saved figures for ${economics.size} products.${unmatched.length ? ` Not found: ${unmatched.slice(0, 5).join(", ")}${unmatched.length > 5 ? "…" : ""}` : ""}`);
      }
      case sub === "/shopify-sync": {
        const n = await syncShopify(ctx.root, ctx.registry, ctx.secrets, client);
        await refreshMatches(repo);
        return back("ok", `Synced costs and sales for ${n} products from Shopify.`);
      }
      case sub === "/rotate-link": {
        await ctx.registry.rotateReportToken(client.id);
        return back("ok", "The report has a new link. The old one no longer works.");
      }
      case sub === "/active": {
        await ctx.registry.update(client.id, { active: form.get("active") === "1" });
        return back("ok", form.get("active") === "1" ? "Daily checks resumed." : "Daily checks paused.");
      }
      case sub === "/delete": {
        if (form.get("confirm") !== client.id) throw new Error(`Type ${client.id} to confirm.`);
        await ctx.registry.remove(client.id);
        return redirect(`/?ok=${encodeURIComponent(`Removed ${client.name}.`)}`);
      }
    }
  } catch (err) {
    return back("error", (err as Error).message);
  }
  throw new HttpError(404, "Not found");
}

async function renderClient(ctx: Context, req: Request, client: Client, flash: { notice: string | null; error: string | null }): Promise<string> {
  const repo = ctx.root.forClient(client.id);
  const stores = await repo.listStores();
  const status = await ctx.registry.storeStatus(stores.map((s) => s.id));
  const products = new Map<string, Map<string, import("../types.js").ProductSnapshot>>();
  for (const s of stores) products.set(s.id, new Map((await repo.currentProducts(s.id)).map((x) => [x.externalId, x])));
  const merchant = stores.find((s) => s.kind === "merchant");
  const name = new Map(stores.map((s) => [s.id, s.name]));
  const decorate = (x: ProductMatch) => ({
    ...x,
    mine: merchant ? products.get(merchant.id)?.get(x.merchantExternalId) : undefined,
    theirs: products.get(x.competitorStoreId)?.get(x.competitorExternalId),
    storeName: name.get(x.competitorStoreId) ?? x.competitorStoreId,
  });
  const suggested = await repo.listMatches("suggested");
  const currency = merchant ? [...(products.get(merchant.id)?.values() ?? [])].find((x) => x.currency)?.currency : undefined;
  return clientPage(
    {
      client,
      baseUrl: req.baseUrl,
      stores: stores.map((s) => ({ ...s, ...(status.get(s.id) ?? { products: 0 }) })),
      suggested: suggested.slice(0, 40).map(decorate),
      suggestedTotal: suggested.length,
      confirmed: (await repo.listMatches("confirmed")).map(decorate),
      config: withClientSettings(DEFAULT_CONFIG, client.settings),
      shopifyEnabled: Boolean(ctx.env.SHOPIFY_API_KEY && ctx.env.SHOPIFY_API_SECRET),
      currency,
    },
    flash,
  );
}

// ---------- Shopify ----------

function shopifyCreds(ctx: Context) {
  if (!ctx.env.SHOPIFY_API_KEY || !ctx.env.SHOPIFY_API_SECRET) throw new HttpError(404, "Shopify is not configured");
  return { apiKey: ctx.env.SHOPIFY_API_KEY, apiSecret: ctx.env.SHOPIFY_API_SECRET };
}

/**
 * Starts an install. Reached three ways: the admin's Connect button, a link sent to the
 * client (?client=ID&shop=...), or Shopify itself opening the app URL with a signed query.
 */
async function shopifyInstall(ctx: Context, req: Request): Promise<Reply> {
  const creds = shopifyCreds(ctx);
  const shop = normaliseShop(req.query.get("shop"));
  if (!shop) return text("Give the shop's address, e.g. ?shop=brand.myshopify.com", 400);
  let clientId = req.query.get("client") ?? "";
  if (req.query.has("hmac")) {
    if (!verifyQueryHmac(req.query, creds.apiSecret)) return text("Invalid Shopify signature", 401);
    // Opened from Shopify admin: an installed shop goes to its report, a new one installs for its matching client.
    clientId ||= (await ctx.registry.byShopifyShop(shop))?.id ?? "";
  }
  const client = clientId ? await ctx.registry.get(clientId) : null;
  if (!client) return text("This install link is missing the client it belongs to. Ask for a new link.", 400);
  const nonce = randomToken();
  const state = ctx.secrets.sign(`${nonce}:${client.id}:${shop}`);
  return redirect(authorizeUrl(shop, creds, `${req.baseUrl}/shopify/callback`, nonce), {
    "set-cookie": cookie(STATE_COOKIE, state, { maxAge: 600, path: "/shopify", secure: secure(req) }),
  });
}

async function shopifyCallback(ctx: Context, req: Request): Promise<Reply> {
  const creds = shopifyCreds(ctx);
  const q = req.query;
  if (!verifyQueryHmac(q, creds.apiSecret)) return text("Invalid Shopify signature", 401);
  const shop = normaliseShop(q.get("shop"));
  const state = ctx.secrets.unsign(req.cookies.get(STATE_COOKIE));
  const [nonce, clientId, stateShop] = (state ?? "").split(":");
  if (!shop || !state || nonce !== q.get("state") || stateShop !== shop) return text("This install link has expired. Start again from the Connect button.", 400);
  const code = q.get("code");
  if (!code) return text("Shopify did not send an install code", 400);
  const client = await ctx.registry.get(clientId!);
  if (!client) return text("That client no longer exists", 400);

  const { accessToken, scopes } = await exchangeCode(shop, code, creds);
  await ctx.registry.saveShopifyInstall(client.id, { shop, tokenEnc: ctx.secrets.encrypt(accessToken), scopes });

  const repo = ctx.root.forClient(client.id);
  const gql = adminGraphQL(shop, accessToken);
  let message = `Connected ${shop} with read-only access.`;
  try {
    // Their storefront becomes the client's own store if it isn't set yet.
    if ((await repo.listStores("merchant")).length === 0) {
      const info = await shopInfo(gql);
      const store = storeFromInput(info.url, "merchant", info.name);
      await repo.upsertStore(store);
      await startChecks(ctx, req, [store.id]);
      message += ` Added ${info.name} as their store; costs and sales sync after its first check.`;
    } else {
      const n = await syncShopify(ctx.root, ctx.registry, ctx.secrets, (await ctx.registry.get(client.id))!);
      message += ` Synced costs and sales for ${n} products.`;
    }
  } catch (err) {
    message += ` The first sync will run tonight (${(err as Error).message}).`;
  }
  const clear = cookie(STATE_COOKIE, "", { maxAge: 0, path: "/shopify", secure: secure(req) });
  if (isAdmin(ctx, req)) return redirect(`/clients/${client.id}?ok=${encodeURIComponent(message)}`, { "set-cookie": clear });
  return redirect(`/r/${client.reportToken}`, { "set-cookie": clear });
}

/** app/uninstalled and the mandatory privacy webhooks. We keep no customer data, so only shop data needs removing. */
async function shopifyWebhook(ctx: Context, req: Request): Promise<Reply> {
  const creds = shopifyCreds(ctx);
  if (req.method !== "POST") return text("Method not allowed", 405);
  const body = await req.rawBody();
  if (!verifyWebhookHmac(body, req.headers["x-shopify-hmac-sha256"] as string | undefined, creds.apiSecret)) return text("Invalid signature", 401);
  const topic = String(req.headers["x-shopify-topic"] ?? "");
  const shop = normaliseShop(String(req.headers["x-shopify-shop-domain"] ?? ""));
  if (shop && (topic === "app/uninstalled" || topic === "shop/redact")) await ctx.registry.forgetShopify(shop);
  // customers/data_request and customers/redact: we never read or store customer details.
  return text("ok");
}

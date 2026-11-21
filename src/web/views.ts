import type { ProductMatch, ProductSnapshot, Store } from "../types.js";
import type { Client } from "../store/clients.js";
import type { Config } from "../config.js";
import { formatCents } from "../money.js";
import { esc } from "./http.js";

/** The admin pages: a calm, plain look that matches the reports. */

const CSS = `
:root { --bg:#f7f6f3; --card:#fff; --ink:#23262f; --muted:#6b6f7b; --line:#e6e3dc; --accent:#5b7fa6; --accent-soft:#e7eef6;
  --good:#4f8a6b; --good-soft:#e5f1ea; --warn:#b07a3b; --warn-soft:#f6eddf; --bad:#a65656; --bad-soft:#f5e4e4; }
@media (prefers-color-scheme: dark) { :root { --bg:#16181d; --card:#1e2128; --ink:#e8e9ec; --muted:#9a9eab; --line:#2e323b;
  --accent:#8fb0d6; --accent-soft:#243142; --good:#86c3a2; --good-soft:#1f3329; --warn:#d9a96d; --warn-soft:#3a2f20; --bad:#d99090; --bad-soft:#3a2424; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
header.top { background:var(--card); border-bottom:1px solid var(--line); }
header.top .in { max-width:1080px; margin:0 auto; padding:14px 16px; display:flex; gap:16px; align-items:center; justify-content:space-between; }
header.top a.brand { font-weight:700; color:var(--ink); text-decoration:none; letter-spacing:.2px; }
main { max-width:1080px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:24px; margin:0 0 4px; } h2 { font-size:17px; margin:0 0 12px; }
p.sub { color:var(--muted); margin:0 0 20px; }
section.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin:0 0 18px; }
.grid { display:grid; gap:18px; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
table { width:100%; border-collapse:collapse; font-size:14px; }
th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.4px; }
.wrap { overflow-x:auto; }
a { color:var(--accent); }
.muted { color:var(--muted); } .small { font-size:13px; }
.pill { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; background:var(--accent-soft); color:var(--accent); }
.pill.good { background:var(--good-soft); color:var(--good); } .pill.warn { background:var(--warn-soft); color:var(--warn); } .pill.bad { background:var(--bad-soft); color:var(--bad); }
form.inline { display:inline; margin:0; }
form.stack { display:grid; gap:10px; }
label { display:grid; gap:4px; font-size:13px; color:var(--muted); }
input, select, textarea { font:inherit; color:var(--ink); background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; width:100%; }
textarea { min-height:90px; }
.row { display:flex; gap:10px; flex-wrap:wrap; align-items:end; } .row > * { flex:1 1 160px; }
button { font:inherit; border:0; border-radius:8px; padding:8px 14px; background:var(--accent); color:#fff; cursor:pointer; }
button.ghost { background:transparent; color:var(--accent); border:1px solid var(--line); padding:4px 10px; }
button.danger { background:var(--bad); }
.notice { padding:10px 14px; border-radius:10px; margin:0 0 18px; background:var(--good-soft); color:var(--good); }
.notice.error { background:var(--bad-soft); color:var(--bad); }
code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; word-break:break-all; }
`;

export function page(title: string, body: string, options: { admin?: boolean; notice?: string | null; error?: string | null } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header class="top"><div class="in"><a class="brand" href="/">Undercut</a>
${options.admin ? `<form class="inline" method="post" action="/logout"><button class="ghost" type="submit">Sign out</button></form>` : ""}</div></header>
<main>${options.notice ? `<div class="notice">${esc(options.notice)}</div>` : ""}${options.error ? `<div class="notice error">${esc(options.error)}</div>` : ""}${body}</main>
</body></html>`;
}

export function loginPage(error?: string): string {
  return page(
    "Sign in · Undercut",
    `<section class="card" style="max-width:420px;margin:40px auto">
<h1>Sign in</h1><p class="sub">Competitor prices, promotions and launches, for every client in one place.</p>
<form class="stack" method="post" action="/login"><label>Password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
<button type="submit">Sign in</button></form></section>`,
    { error },
  );
}

export function setupPage(missing: string[]): string {
  return page(
    "Setup needed · Undercut",
    `<section class="card"><h1>Almost there</h1><p>This deployment is missing settings: ${missing.map((m) => `<code>${esc(m)}</code>`).join(", ")}.</p>
<p class="muted">Add them under the Vercel project's Settings, Environment Variables, then redeploy. The README lists what each one is for.</p></section>`,
  );
}

export interface ClientRow {
  client: Client;
  merchant?: Store;
  competitors: number;
  confirmedPairs: number;
  lastCheckedAt?: Date;
}

const when = (d?: Date) => (d ? d.toLocaleString("en-IE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Dublin" }) : "never");

export function dashboardPage(rows: ClientRow[], baseUrl: string, flash: { notice?: string | null; error?: string | null }): string {
  const list = rows.length
    ? `<div class="wrap"><table><thead><tr><th>Client</th><th>Their store</th><th>Competitors</th><th>Pairs</th><th>Last check</th><th>Report</th></tr></thead><tbody>
${rows
  .map(
    (r) => `<tr><td><a href="/clients/${esc(r.client.id)}">${esc(r.client.name)}</a>${r.client.active ? "" : ' <span class="pill warn">paused</span>'}</td>
<td>${r.merchant ? `<a href="${esc(r.merchant.url)}" rel="noreferrer">${esc(r.merchant.name)}</a>` : '<span class="muted">not set</span>'}</td>
<td>${r.competitors}</td><td>${r.confirmedPairs}</td><td class="small">${esc(when(r.lastCheckedAt))}</td>
<td><a href="${esc(`${baseUrl}/r/${r.client.reportToken}`)}">Open</a></td></tr>`,
  )
  .join("")}</tbody></table></div>`
    : `<p class="muted">No clients yet. Add the first one below.</p>`;

  return page(
    "Clients · Undercut",
    `<h1>Clients</h1><p class="sub">Each client has their own store, the competitors they care about, product pairs and pricing rules. Every store is checked once a day.</p>
<section class="card">${list}</section>
<section class="card"><h2>Add a client</h2>
<form class="stack" method="post" action="/clients">
<div class="row"><label>Business name<input name="name" required placeholder="SOSU Cosmetics"></label>
<label>Their online store<input name="store" placeholder="https://sosucosmetics.com"></label></div>
<label>Competitors, one store per line (a regional site such as https://brand.com/ie is fine)<textarea name="competitors" placeholder="https://www.charlottetilbury.com/ie&#10;https://sculptedbyaimee.com"></textarea></label>
<div><button type="submit">Add client</button> <span class="muted small">The first check starts straight away.</span></div>
</form></section>`,
    { admin: true, ...flash },
  );
}

export interface ClientPageData {
  client: Client;
  baseUrl: string;
  stores: (Store & { products: number; lastCheckedAt?: Date; lastError?: string })[];
  suggested: (ProductMatch & { mine?: ProductSnapshot; theirs?: ProductSnapshot; storeName: string })[];
  suggestedTotal: number;
  confirmed: (ProductMatch & { mine?: ProductSnapshot; theirs?: ProductSnapshot; storeName: string })[];
  config: Config;
  shopifyEnabled: boolean;
  currency?: string;
}

export function clientPage(d: ClientPageData, flash: { notice?: string | null; error?: string | null }): string {
  const c = d.client;
  const id = esc(c.id);
  const reportUrl = `${d.baseUrl}/r/${c.reportToken}`;
  const money = (p?: ProductSnapshot) => (p ? formatCents(p.priceCents, p.currency ?? d.currency) : "—");
  const merchant = d.stores.find((s) => s.kind === "merchant");

  const stores = d.stores.length
    ? `<div class="wrap"><table><thead><tr><th>Store</th><th></th><th>Products</th><th>Last check</th><th></th></tr></thead><tbody>
${d.stores
  .map(
    (s) => `<tr><td><a href="${esc(s.url)}" rel="noreferrer">${esc(s.name)}</a><div class="small muted mono">${esc(s.url)}</div></td>
<td>${s.kind === "merchant" ? '<span class="pill good">their store</span>' : '<span class="pill">competitor</span>'}</td>
<td>${s.products}</td><td class="small">${esc(when(s.lastCheckedAt))}${s.lastError ? `<div class="pill bad" title="${esc(s.lastError)}">last check failed</div>` : ""}</td>
<td><form class="inline" method="post" action="/clients/${id}/stores/${esc(s.id)}/remove"><button class="ghost" type="submit">Remove</button></form></td></tr>`,
  )
  .join("")}</tbody></table></div>`
    : '<p class="muted">No stores yet.</p>';

  const pairRow = (m: ClientPageData["suggested"][number], actions: string) =>
    `<tr><td>${m.mine ? `<a href="${esc(m.mine.url)}" rel="noreferrer">${esc(m.mine.title)}</a>` : esc(m.merchantExternalId)}<div class="small muted">${money(m.mine)}</div></td>
<td>${esc(m.storeName)}: ${m.theirs ? `<a href="${esc(m.theirs.url)}" rel="noreferrer">${esc(m.theirs.title)}</a>` : esc(m.competitorExternalId)}<div class="small muted">${money(m.theirs)}</div></td>
<td>${m.confidence.toFixed(2)}</td><td style="white-space:nowrap">${actions}</td></tr>`;
  const matchForm = (m: ProductMatch, action: string, label: string, cls = "ghost") =>
    `<form class="inline" method="post" action="/clients/${id}/matches"><input type="hidden" name="key" value="${esc(JSON.stringify([m.merchantExternalId, m.competitorStoreId, m.competitorExternalId]))}"><input type="hidden" name="status" value="${action}"><button class="${cls}" type="submit">${label}</button></form>`;

  const suggested = d.suggested.length
    ? `<div class="wrap"><table><thead><tr><th>Their product</th><th>Competitor product</th><th>Match</th><th></th></tr></thead><tbody>
${d.suggested.map((m) => pairRow(m, `${matchForm(m, "confirmed", "Confirm")} ${matchForm(m, "rejected", "Reject")}`)).join("")}</tbody></table></div>
${d.suggestedTotal > d.suggested.length ? `<p class="small muted">Showing the ${d.suggested.length} closest of ${d.suggestedTotal} suggestions.</p>` : ""}`
    : '<p class="muted">No suggestions waiting. They appear after a check when products look alike.</p>';

  const confirmed = d.confirmed.length
    ? `<details><summary>${d.confirmed.length} confirmed pairs</summary><div class="wrap"><table><tbody>
${d.confirmed.map((m) => pairRow(m, matchForm(m, "rejected", "Unpair"))).join("")}</tbody></table></div></details>`
    : '<p class="muted small">No confirmed pairs yet. Until there are, the report shows the competitor market view.</p>';

  const p = d.config.pricing;
  const opt = (v: string, cur: string, label: string) => `<option value="${v}"${v === cur ? " selected" : ""}>${label}</option>`;

  const shopify = !d.shopifyEnabled
    ? '<p class="muted small">Shopify connection is not configured on this deployment yet (needs SHOPIFY_API_KEY and SHOPIFY_API_SECRET).</p>'
    : c.shopify?.hasToken
      ? `<p><span class="pill good">connected</span> <span class="mono">${esc(c.shopify.shop)}</span></p>
<p class="small muted">Read-only access: ${esc(c.shopify.scopes ?? "")}. Costs and weekly sales last synced ${esc(when(c.shopify.syncedAt))}.</p>
<form class="inline" method="post" action="/clients/${id}/shopify-sync"><button class="ghost" type="submit">Sync costs and sales now</button></form>`
      : `<p class="small muted">Lets Undercut read product costs and recent sales (never change anything), so the report can put money figures on each competitor move.</p>
<form class="row" method="get" action="/shopify/install"><input type="hidden" name="client" value="${id}">
<label>Shop address<input name="shop" placeholder="brand.myshopify.com" required></label><div><button type="submit">Connect Shopify</button></div></form>
<p class="small muted">Or send the client this link to approve it themselves: <span class="mono">${esc(`${d.baseUrl}/shopify/install?client=${c.id}&shop=`)}</span>their-shop.myshopify.com</p>`;

  return page(
    `${c.name} · Undercut`,
    `<p class="small"><a href="/">All clients</a></p>
<h1>${esc(c.name)}</h1>
<p class="sub">Report link to share with the client: <a class="mono" href="${esc(reportUrl)}">${esc(reportUrl)}</a></p>
<div class="row" style="margin-bottom:18px">
<form class="inline" method="post" action="/clients/${id}/check"><button type="submit">Check all stores now</button></form>
<form class="inline" method="post" action="/clients/${id}/rotate-link"><button class="ghost" type="submit">Replace the report link</button></form>
<form class="inline" method="post" action="/clients/${id}/active"><input type="hidden" name="active" value="${c.active ? "0" : "1"}"><button class="ghost" type="submit">${c.active ? "Pause daily checks" : "Resume daily checks"}</button></form>
</div>

<section class="card"><h2>Stores</h2>${stores}
<form class="row" method="post" action="/clients/${id}/stores" style="margin-top:14px">
<label>Store address<input name="url" required placeholder="https://competitor.com"></label>
<label>Name (optional)<input name="name"></label>
<label>Role<select name="role">${merchant ? "" : opt("merchant", "competitor", "Their own store")}${opt("competitor", "competitor", "Competitor")}</select></label>
<div><button type="submit">Add store</button></div></form></section>

<section class="card"><h2>Product pairs</h2>
<p class="small muted">Pairs tell the report which of their products competes with which competitor product.</p>
${suggested}
<form class="row" method="post" action="/clients/${id}/confirm-above" style="margin-top:12px">
<label>Confirm every suggestion at or above<input name="min" type="number" step="0.05" min="0.5" max="1" value="0.85"></label><div><button class="ghost" type="submit">Confirm</button></div></form>
<h2 style="margin-top:18px">Pair by hand</h2>
<p class="small muted">For own-brand ranges that don't sell the same items: pick their product and the competitor product it competes with.</p>
<form class="row" method="post" action="/clients/${id}/pair">
<label>Their product page<input name="yours" required placeholder="https://sosucosmetics.com/products/..."></label>
<label>Competitor product page<input name="theirs" required placeholder="https://competitor.com/products/..."></label>
<div><button type="submit">Pair</button></div></form>
<div style="margin-top:14px">${confirmed}</div></section>

<div class="grid">
<section class="card"><h2>Pricing rules and alerts</h2>
<form class="stack" method="post" action="/clients/${id}/settings">
<div class="row"><label>Strategy<select name="strategy">${opt("beat", p.strategy, "Beat the cheapest rival")}${opt("match", p.strategy, "Match the cheapest rival")}${opt("premium", p.strategy, "Stay a set % above")}</select></label>
<label>Beat by %<input name="beatByPercent" type="number" step="0.5" min="0" value="${p.beatByPercent}"></label>
<label>Premium %<input name="premiumPercent" type="number" step="0.5" min="0" value="${p.premiumPercent}"></label></div>
<div class="row"><label>Minimum margin %<input name="minMarginPercent" type="number" step="1" min="0" value="${p.minMarginPercent}"></label>
<label>Largest single change %<input name="maxChangePercent" type="number" step="1" min="1" value="${p.maxChangePercent}"></label>
<label>Price endings<select name="rounding">${opt("match", p.rounding, "Like the current price")}${opt("99", p.rounding, ".99")}${opt("95", p.rounding, ".95")}${opt("none", p.rounding, "As computed")}</select></label></div>
<label>Slack or webhook URL for urgent alerts (optional)<input name="webhookUrl" type="url" value="${esc(d.config.alerts.webhookUrl ?? "")}" placeholder="https://hooks.slack.com/services/..."></label>
<label>Business name<input name="name" value="${esc(c.name)}" required></label>
<div><button type="submit">Save</button></div></form></section>

<section class="card"><h2>Shopify (read-only)</h2>${shopify}
<h2 style="margin-top:18px">Costs and sales by file</h2>
<p class="small muted">Not on Shopify? Paste a CSV with a header: <code>url</code> (or <code>id</code> or <code>title</code>), then <code>cost</code> and/or <code>units_per_week</code>.</p>
<form class="stack" method="post" action="/clients/${id}/economics"><textarea name="csv" placeholder="url,cost,units_per_week"></textarea><div><button class="ghost" type="submit">Import</button></div></form>
</section></div>

<section class="card"><h2>Remove this client</h2>
<form class="row" method="post" action="/clients/${id}/delete"><label>Type the client id <code>${id}</code> to confirm<input name="confirm" required></label>
<div><button class="danger" type="submit">Remove client</button></div></form>
<p class="small muted">Their pairs and settings go. Price history of shared stores stays for other clients.</p></section>`,
    { admin: true, ...flash },
  );
}

export function waitingPage(name: string): string {
  return page(
    `${name} · Undercut`,
    `<section class="card"><h1>${esc(name)}</h1><p>The first check of these stores is still running. This page fills in once it finishes, usually within the hour.</p></section>`,
  );
}

export function notFoundPage(): string {
  return page("Not found · Undercut", `<section class="card"><h1>Not found</h1><p class="muted">That page doesn't exist, or the link has been replaced.</p></section>`);
}

import type { ProductMatch, ProductSnapshot, Store } from "../types.js";
import type { Client } from "../store/clients.js";
import type { Config } from "../config.js";
import { formatCents } from "../money.js";
import { esc } from "./http.js";

/**
 * The admin pages. One shared layout: a sidebar to move around, a soft pastel palette,
 * and every page says in plain words what it is for and what to do next.
 */

export const FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">`;

export const THEME = `
:root { --bg:#f6f6fb; --card:#ffffff; --ink:#1e2233; --muted:#646a80; --line:#e6e6f0; --soft:#f1f1f8;
  --accent:#5b63c9; --accent-ink:#ffffff; --accent-soft:#ecebfb; --accent-line:#d6d6f6;
  --good:#2f7a5a; --good-soft:#e4f4ec; --warn:#9a5d22; --warn-soft:#fcefe0; --bad:#a8455d; --bad-soft:#fbe7ec;
  --sky-soft:#e5f1fb; --peach-soft:#fdeee6; --mint-soft:#e3f5ee; --lilac-soft:#efe9fb;
  --shadow:0 1px 2px rgba(30,34,51,.04),0 6px 24px rgba(30,34,51,.05); color-scheme:light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#14151d; --card:#1c1e29; --ink:#e9eaf2; --muted:#9da1b6; --line:#2b2e3d; --soft:#232533;
  --accent:#a3a9f2; --accent-ink:#151722; --accent-soft:#2a2c47; --accent-line:#3a3d63;
  --good:#8fd3b2; --good-soft:#1d3229; --warn:#e8b37c; --warn-soft:#3a2c1d; --bad:#eda2b3; --bad-soft:#3b2229;
  --sky-soft:#1d2b3a; --peach-soft:#36271f; --mint-soft:#1b3129; --lilac-soft:#2a2440; --shadow:none; color-scheme:dark; } }
:root[data-theme="dark"] { --bg:#14151d; --card:#1c1e29; --ink:#e9eaf2; --muted:#9da1b6; --line:#2b2e3d; --soft:#232533;
  --accent:#a3a9f2; --accent-ink:#151722; --accent-soft:#2a2c47; --accent-line:#3a3d63;
  --good:#8fd3b2; --good-soft:#1d3229; --warn:#e8b37c; --warn-soft:#3a2c1d; --bad:#eda2b3; --bad-soft:#3b2229;
  --sky-soft:#1d2b3a; --peach-soft:#36271f; --mint-soft:#1b3129; --lilac-soft:#2a2440; --shadow:none; color-scheme:dark; }
`;

const CSS = `${THEME}
* { box-sizing:border-box; }
[hidden] { display:none !important; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
.shell { display:grid; grid-template-columns:240px 1fr; min-height:100vh; }
.shell.bare { grid-template-columns:1fr; }
aside.side { background:var(--card); border-right:1px solid var(--line); padding:22px 14px; position:sticky; top:0; height:100vh; display:flex; flex-direction:column; gap:4px; }
.logo { display:flex; align-items:center; gap:10px; font-weight:700; font-size:17px; color:var(--ink); padding:4px 10px 18px; letter-spacing:-.01em; }
.logo:hover { text-decoration:none; }
.logo i { width:28px; height:28px; border-radius:8px; background:linear-gradient(135deg,#c9cdfb,#f7c9d6 60%,#cdeedd); display:grid; place-items:center; font-style:normal; font-size:15px; color:#3c3f8f; }
aside .nav a { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:8px; color:var(--muted); font-weight:500; font-size:14px; }
aside .nav a:hover { background:var(--soft); color:var(--ink); text-decoration:none; }
aside .nav a.on { background:var(--accent-soft); color:var(--accent); }
aside .label { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); padding:16px 10px 6px; font-weight:600; }
aside .clients a { font-size:13.5px; padding:6px 10px; }
aside .clients a .dot { width:7px; height:7px; border-radius:50%; background:var(--line); flex:none; }
aside .clients a .dot.good { background:var(--good); } aside .clients a .dot.warn { background:var(--warn); } aside .clients a .dot.bad { background:var(--bad); }
aside .foot { margin-top:auto; }
aside .foot button { width:100%; text-align:left; }
main { padding:32px 40px 80px; max-width:1160px; width:100%; }
.shell.bare main { margin:0 auto; max-width:560px; padding-top:8vh; }
.head { display:flex; flex-wrap:wrap; gap:12px 24px; justify-content:space-between; align-items:flex-start; margin:0 0 24px; }
h1 { font-size:26px; line-height:1.2; margin:0 0 6px; letter-spacing:-.02em; font-weight:700; }
h2 { font-size:17px; margin:0 0 4px; letter-spacing:-.01em; font-weight:600; }
h3 { font-size:15px; margin:0 0 4px; font-weight:600; }
p { margin:0 0 10px; }
.sub { color:var(--muted); margin:0; max-width:680px; }
.muted { color:var(--muted); } .small { font-size:13px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:22px; margin:0 0 20px; box-shadow:var(--shadow); min-width:0; }
.card > header { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:flex-start; gap:8px 16px; margin-bottom:16px; }
.card > header p { color:var(--muted); font-size:13.5px; margin:2px 0 0; max-width:640px; }
.grid2 { display:grid; gap:20px; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); }
.grid2 > .card { margin:0; }
.stack-gap { display:grid; gap:20px; margin-bottom:20px; }
.stats { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); margin:0 0 20px; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px 18px; box-shadow:var(--shadow); }
.stat b { display:block; font-size:26px; font-weight:700; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
.stat span { color:var(--muted); font-size:13px; }
.wrap { overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-size:14px; }
th, td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:middle; }
tr:last-child td { border-bottom:0; }
th { color:var(--muted); font-weight:600; font-size:11.5px; text-transform:uppercase; letter-spacing:.06em; }
td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
.pill { display:inline-flex; align-items:center; gap:5px; padding:2px 9px; border-radius:99px; font-size:12px; font-weight:600; background:var(--accent-soft); color:var(--accent); white-space:nowrap; }
.pill.good { background:var(--good-soft); color:var(--good); } .pill.warn { background:var(--warn-soft); color:var(--warn); } .pill.bad { background:var(--bad-soft); color:var(--bad); } .pill.grey { background:var(--soft); color:var(--muted); }
form.inline { display:inline; margin:0; }
form.stack { display:grid; gap:14px; }
label { display:grid; gap:6px; font-size:13px; font-weight:500; color:var(--ink); }
label .hint { font-weight:400; color:var(--muted); font-size:12.5px; }
input, select, textarea { font:inherit; font-size:14px; color:var(--ink); background:var(--card); border:1px solid var(--line); border-radius:9px; padding:9px 12px; width:100%; transition:border-color .15s, box-shadow .15s; }
input:focus, select:focus, textarea:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
textarea { min-height:96px; resize:vertical; }
.row { display:flex; gap:12px; flex-wrap:wrap; align-items:end; } .row > * { flex:1 1 180px; } .row > .shrink { flex:0 0 auto; }
.actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
button, .btn { font:inherit; font-size:14px; font-weight:600; border:1px solid transparent; border-radius:9px; padding:9px 16px; background:var(--accent); color:var(--accent-ink); cursor:pointer; display:inline-flex; align-items:center; gap:6px; text-decoration:none; white-space:nowrap; line-height:1.3; }
button:hover, .btn:hover { filter:brightness(1.06); text-decoration:none; }
button.ghost, .btn.ghost { background:var(--card); color:var(--ink); border-color:var(--line); }
button.ghost:hover, .btn.ghost:hover { background:var(--soft); filter:none; }
button.small, .btn.small { padding:5px 11px; font-size:13px; }
button.quiet { background:transparent; color:var(--muted); border:0; padding:8px 10px; font-weight:500; }
button.quiet:hover { color:var(--ink); background:var(--soft); }
button.danger { background:var(--bad); color:#fff; }
.notice { padding:12px 16px; border-radius:12px; margin:0 0 20px; background:var(--good-soft); color:var(--good); font-weight:500; border:1px solid transparent; }
.notice.error { background:var(--bad-soft); color:var(--bad); }
code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; word-break:break-all; }
.linkbox { display:flex; gap:8px; align-items:center; background:var(--soft); border:1px solid var(--line); border-radius:10px; padding:6px 6px 6px 12px; }
.linkbox .mono { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; word-break:normal; }
details > summary { cursor:pointer; color:var(--accent); font-weight:500; font-size:14px; list-style:none; }
details > summary::-webkit-details-marker { display:none; }
details > summary::before { content:"▸ "; } details[open] > summary::before { content:"▾ "; }
.empty { text-align:center; padding:26px 16px; color:var(--muted); background:var(--soft); border-radius:12px; border:1px dashed var(--line); }
.prod { display:flex; flex-direction:column; gap:1px; } .prod small { color:var(--muted); font-size:12.5px; }
.conf { display:inline-block; min-width:44px; text-align:center; }
/* Steps (dashboard explainer, setup tracker, wizard) */
.steps { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); }
.step { border-radius:14px; padding:18px; border:1px solid var(--line); background:var(--card); }
.step .n { width:28px; height:28px; border-radius:50%; display:grid; place-items:center; font-weight:700; font-size:13px; margin-bottom:10px; background:var(--accent-soft); color:var(--accent); }
.step:nth-child(1) { background:var(--lilac-soft); } .step:nth-child(2) { background:var(--sky-soft); } .step:nth-child(3) { background:var(--mint-soft); } .step:nth-child(4) { background:var(--peach-soft); }
.step p { color:var(--muted); font-size:13.5px; margin:0; }
.hero { background:linear-gradient(120deg,var(--lilac-soft),var(--sky-soft) 55%,var(--mint-soft)); border:1px solid var(--line); border-radius:18px; padding:30px; margin:0 0 20px; }
.hero h1 { font-size:28px; } .hero .sub { color:var(--ink); opacity:.8; font-size:15.5px; margin-bottom:18px; }
.track { list-style:none; margin:0; padding:0; display:grid; gap:2px; }
.track li { display:grid; grid-template-columns:30px 1fr auto; gap:12px; align-items:center; padding:12px 4px; border-bottom:1px solid var(--line); }
.track li:last-child { border-bottom:0; }
.track .ic { width:26px; height:26px; border-radius:50%; display:grid; place-items:center; font-size:13px; font-weight:700; background:var(--soft); color:var(--muted); border:1px solid var(--line); }
.track li.done .ic { background:var(--good-soft); color:var(--good); border-color:transparent; }
.track li.now .ic { background:var(--accent); color:var(--accent-ink); border-color:transparent; }
.track li.problem .ic { background:var(--bad-soft); color:var(--bad); border-color:transparent; }
.track li p { margin:0; color:var(--muted); font-size:13.5px; }
.spin { display:inline-block; width:12px; height:12px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation:spin .8s linear infinite; vertical-align:-1px; }
@keyframes spin { to { transform:rotate(360deg); } }
/* Client cards on the dashboard */
.clients-grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); }
.ccard { display:flex; flex-direction:column; gap:12px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px; box-shadow:var(--shadow); color:var(--ink); }
.ccard:hover { border-color:var(--accent-line); text-decoration:none; }
.ccard .top { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
.ccard .meta { display:flex; gap:16px; color:var(--muted); font-size:13px; }
.ccard .meta b { color:var(--ink); font-weight:600; }
.ccard .next { background:var(--soft); border-radius:10px; padding:10px 12px; font-size:13.5px; }
.ccard .next b { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin-bottom:2px; }
/* In-page tabs on the client page */
.tabs { display:flex; gap:4px; border-bottom:1px solid var(--line); margin:0 0 22px; overflow-x:auto; position:sticky; top:0; background:var(--bg); z-index:2; padding-top:6px; }
.tabs a { padding:10px 14px; color:var(--muted); font-weight:500; font-size:14px; border-bottom:2px solid transparent; white-space:nowrap; }
.tabs a:hover { color:var(--ink); text-decoration:none; }
.tabs a .count { background:var(--accent-soft); color:var(--accent); border-radius:99px; padding:0 7px; font-size:12px; margin-left:4px; }
section.anchor { scroll-margin-top:60px; }
/* Wizard */
.wizard { max-width:760px; }
.progress { display:flex; gap:8px; margin:0 0 22px; }
.progress span { flex:1; height:5px; border-radius:5px; background:var(--line); }
.progress span.on { background:var(--accent); }
.wizard fieldset { border:0; padding:0; margin:0; }
.js .wizard fieldset:not(.current) { display:none; }
html:not(.js) #next { display:none; }
.wizard .nav-btns { display:flex; justify-content:space-between; gap:10px; margin-top:22px; }
.choice { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); }
.choice label { cursor:pointer; border:1px solid var(--line); border-radius:12px; padding:14px; gap:4px; font-weight:400; background:var(--card); }
.choice label:has(input:checked) { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
.choice input { width:auto; margin:0 0 4px; accent-color:var(--accent); }
.choice b { font-size:14px; } .choice small { color:var(--muted); font-size:12.5px; }
.check { display:flex; gap:10px; align-items:flex-start; font-weight:400; }
.check input { width:auto; margin-top:3px; accent-color:var(--accent); }
.comp-list { display:grid; gap:8px; }
.comp-list .item { display:flex; gap:8px; }
.review { display:grid; gap:10px; background:var(--soft); border-radius:12px; padding:16px; font-size:14px; }
.review div { display:grid; grid-template-columns:140px 1fr; gap:10px; } .review dt { color:var(--muted); }
.mobile-top { display:none; }
@media (max-width: 860px) {
  .shell { grid-template-columns:1fr; }
  aside.side { display:none; }
  .mobile-top { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:12px 16px; background:var(--card); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:5; }
  .mobile-top .logo { padding:0; }
  .mobile-top nav { display:flex; gap:12px; font-size:14px; font-weight:500; }
  main { padding:22px 16px 64px; }
  .review div { grid-template-columns:1fr; gap:2px; }
}
`;

/** Small shared script: copy buttons, and the step-by-step wizard. Works without it too. */
const SCRIPT = `<script>
document.documentElement.classList.add("js");
document.addEventListener("click", function (e) {
  var b = e.target.closest("[data-copy]"); if (!b) return;
  e.preventDefault();
  navigator.clipboard.writeText(b.getAttribute("data-copy")).then(function () { var t = b.textContent; b.textContent = "Copied"; setTimeout(function () { b.textContent = t; }, 1600); });
});
</script>`;

export type Nav = "dashboard" | "new" | "help" | { client: string };

export interface Layout {
  admin?: boolean;
  notice?: string | null;
  error?: string | null;
  nav?: Nav;
  /** Clients for the sidebar list. */
  clients?: { id: string; name: string; tone?: Tone }[];
  /** Seconds until the page reloads itself, while a check is running. */
  refresh?: number;
}

type Tone = "good" | "warn" | "bad" | "grey";

export function page(title: string, body: string, options: Layout = {}): string {
  const on = (n: Nav) => (JSON.stringify(n) === JSON.stringify(options.nav) ? ' class="on"' : "");
  const sidebar = options.admin
    ? `<aside class="side"><a class="logo" href="/"><i>◆</i>Undercut</a>
<nav class="nav"><a href="/"${on("dashboard")}>▦ Dashboard</a><a href="/clients/new"${on("new")}>＋ Add a client</a><a href="/help"${on("help")}>? How it works</a></nav>
${options.clients?.length ? `<div class="label">Clients</div><nav class="nav clients">${options.clients.map((c) => `<a href="/clients/${esc(c.id)}"${on({ client: c.id })}><span class="dot ${c.tone ?? ""}"></span>${esc(c.name)}</a>`).join("")}</nav>` : ""}
<div class="foot"><form method="post" action="/logout"><button class="quiet" type="submit">Sign out</button></form></div></aside>
<div class="mobile-top"><a class="logo" href="/"><i>◆</i>Undercut</a><nav><a href="/">Dashboard</a><a href="/clients/new">Add client</a><a href="/help">Help</a></nav></div>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${options.refresh ? `<meta http-equiv="refresh" content="${options.refresh}">` : ""}<meta name="robots" content="noindex">
<title>${esc(title)}</title>${FONT_LINK}<style>${CSS}</style>${SCRIPT}</head><body>
<div class="shell${options.admin ? "" : " bare"}">${sidebar}<main>
${options.notice ? `<div class="notice">${esc(options.notice)}</div>` : ""}${options.error ? `<div class="notice error">${esc(options.error)}</div>` : ""}${body}</main></div>
</body></html>`;
}

export function loginPage(error?: string): string {
  return page(
    "Sign in · Undercut",
    `<div style="text-align:center;margin-bottom:22px"><a class="logo" href="/" style="justify-content:center"><i>◆</i>Undercut</a></div>
<section class="card" style="padding:30px">
<h1>Welcome back</h1><p class="sub" style="margin-bottom:22px">Undercut watches your clients' competitors every day and turns what it sees into a clear weekly report.</p>
<form class="stack" method="post" action="/login"><label>Password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
<button type="submit" style="justify-content:center">Sign in</button></form></section>`,
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

// ---------- status of a client, in plain words ----------

export interface ClientRow {
  client: Client;
  merchant?: Store;
  competitors: number;
  confirmedPairs: number;
  suggestedPairs?: number;
  /** Stores not read yet (first check still running). */
  checking?: number;
  /** Stores whose last check failed. */
  failing?: number;
  lastCheckedAt?: Date;
}

export interface NextStep {
  tone: Tone;
  status: string;
  next: string;
  /** Where the next step happens on the client page. */
  anchor: string;
}

/** What state a client is in and what to do next. Used on the dashboard, the sidebar and the client page. */
export function nextStep(r: ClientRow): NextStep {
  const suggested = r.suggestedPairs ?? 0;
  if (!r.client.active) return { tone: "grey", status: "Paused", next: "Daily checks are paused. Resume them to keep the report up to date.", anchor: "#settings" };
  if (!r.merchant && r.competitors === 0) return { tone: "warn", status: "Needs stores", next: "Add their store and at least one competitor.", anchor: "#stores" };
  if (r.checking) return { tone: "grey", status: "First check running", next: "Reading every product. This takes a few minutes; nothing to do yet.", anchor: "#stores" };
  if (r.failing) return { tone: "bad", status: "A store failed", next: `${r.failing} store${r.failing === 1 ? "" : "s"} couldn't be read. Check the address.`, anchor: "#stores" };
  if (r.competitors === 0) return { tone: "warn", status: "Needs competitors", next: "Add the competitors they want to watch.", anchor: "#stores" };
  if (!r.merchant) return { tone: "good", status: "Market view live", next: "Add their own store to get price advice as well.", anchor: "#stores" };
  if (r.confirmedPairs === 0 && suggested > 0) return { tone: "warn", status: "Review pairs", next: `Confirm which products compete: ${suggested} suggested.`, anchor: "#pairs" };
  if (r.confirmedPairs === 0) return { tone: "warn", status: "Needs pairs", next: "No look-alike products found. Pair a few by hand.", anchor: "#pairs" };
  if (suggested > 0) return { tone: "good", status: "Live", next: `${suggested} new pair suggestion${suggested === 1 ? "" : "s"} to review.`, anchor: "#pairs" };
  return { tone: "good", status: "Live", next: "All set. Share the report link; it updates every morning.", anchor: "#overview" };
}

const when = (d?: Date) => (d ? d.toLocaleString("en-IE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Dublin" }) : "never");
const ago = (d?: Date) => {
  if (!d) return "not yet";
  const m = Math.round((Date.now() - d.getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};
const pill = (tone: Tone, label: string, spin = false) => `<span class="pill ${tone}">${spin ? '<span class="spin"></span>' : ""}${esc(label)}</span>`;

export const sidebarClients = (rows: ClientRow[]) => rows.map((r) => ({ id: r.client.id, name: r.client.name, tone: nextStep(r).tone }));

const HOW_STEPS = `<div class="steps">
<div class="step"><div class="n">1</div><h3>Add a client</h3><p>Their online store and the competitors they care about. Two minutes.</p></div>
<div class="step"><div class="n">2</div><h3>Undercut reads every product</h3><p>Prices, stock, offers and new launches, from each public website. Then again every morning.</p></div>
<div class="step"><div class="n">3</div><h3>Confirm the product pairs</h3><p>Which of their products competes with which rival product. Close matches are confirmed for you.</p></div>
<div class="step"><div class="n">4</div><h3>Share the report</h3><p>A private link with what to change, where they're undercut, and what rivals did this week.</p></div>
</div>`;

export function dashboardPage(rows: ClientRow[], baseUrl: string, flash: { notice?: string | null; error?: string | null }): string {
  const steps = rows.map(nextStep);
  const todo = rows.filter((_, i) => steps[i]!.tone === "warn" || steps[i]!.tone === "bad");
  const stores = rows.reduce((n, r) => n + r.competitors + (r.merchant ? 1 : 0), 0);
  const waiting = rows.reduce((n, r) => n + (r.suggestedPairs ?? 0), 0);

  if (rows.length === 0) {
    return page(
      "Dashboard · Undercut",
      `<div class="hero"><h1>Know what your competitors are doing, every morning.</h1>
<p class="sub">Undercut checks competitors' websites once a day, reads their prices, stock and promotions, and turns it into a weekly report for each client: which prices to change, where they're being undercut, and what rivals launched or put on sale.</p>
<a class="btn" href="/clients/new">Add your first client →</a></div>
<section class="card"><header><div><h2>How it works</h2><p>Set a client up once. After that it runs by itself.</p></div></header>${HOW_STEPS}</section>`,
      { admin: true, nav: "dashboard", ...flash },
    );
  }

  const cards = rows
    .map((r, i) => {
      const s = steps[i]!;
      const report = `${baseUrl}/r/${r.client.reportToken}`;
      return `<div class="ccard"><div class="top"><div><h3 style="margin:0"><a href="/clients/${esc(r.client.id)}" style="color:var(--ink)">${esc(r.client.name)}</a></h3>
<div class="small muted">${r.merchant ? esc(r.merchant.url.replace(/^https?:\/\/(www\.)?/, "")) : "No store of their own yet"}</div></div>${pill(s.tone, s.status, s.status === "First check running")}</div>
<div class="meta"><span><b>${r.competitors}</b> competitor${r.competitors === 1 ? "" : "s"}</span><span><b>${r.confirmedPairs}</b> pairs</span><span>Checked ${esc(ago(r.lastCheckedAt))}</span></div>
<div class="next"><b>Next step</b>${esc(s.next)}</div>
<div class="actions"><a class="btn small" href="/clients/${esc(r.client.id)}${s.anchor}">Open</a><a class="btn small ghost" href="${esc(report)}" target="_blank" rel="noreferrer">View report</a><button class="small ghost" data-copy="${esc(report)}">Copy link</button></div></div>`;
    })
    .join("");

  return page(
    "Dashboard · Undercut",
    `<div class="head"><div><h1>Dashboard</h1><p class="sub">Every store below is checked each morning at 04:00 UTC, and the reports update by 06:00.</p></div>
<a class="btn" href="/clients/new">＋ Add a client</a></div>
<div class="stats"><div class="stat"><b>${rows.length}</b><span>clients</span></div><div class="stat"><b>${stores}</b><span>stores watched</span></div>
<div class="stat"><b>${waiting}</b><span>pair suggestions to review</span></div><div class="stat"><b>${todo.length}</b><span>${todo.length === 1 ? "client needs" : "clients need"} attention</span></div></div>
<div class="clients-grid">${cards}</div>
<details style="margin-top:28px"><summary>How Undercut works</summary><div style="margin-top:14px">${HOW_STEPS}</div></details>`,
    { admin: true, nav: "dashboard", clients: sidebarClients(rows), ...flash },
  );
}

// ---------- onboarding ----------

export interface WizardValues {
  name?: string;
  store?: string;
  competitors?: string[];
  strategy?: string;
  minMarginPercent?: string;
  autoConfirm?: boolean;
}

export function newClientPage(v: WizardValues, sidebar: Layout["clients"], error?: string | null): string {
  const comps = v.competitors?.length ? v.competitors : ["", ""];
  const strategy = v.strategy ?? "beat";
  const radio = (value: string, title: string, note: string) =>
    `<label><input type="radio" name="strategy" value="${value}"${value === strategy ? " checked" : ""}><b>${title}</b><small>${note}</small></label>`;
  const compRow = (value: string, i: number) =>
    `<div class="item"><input name="competitor" value="${esc(value)}" placeholder="${i === 0 ? "https://www.charlottetilbury.com/ie" : "https://competitor.com"}" inputmode="url"><button type="button" class="ghost small" data-remove aria-label="Remove">✕</button></div>`;

  return page(
    "Add a client · Undercut",
    `<div class="wizard"><div class="head"><div><h1>Add a client</h1><p class="sub">Three short steps. When you finish, Undercut starts reading every store straight away.</p></div></div>
<div class="progress" aria-hidden="true"><span class="on"></span><span></span><span></span></div>
<form method="post" action="/clients" class="card" id="wizard" novalidate>
<fieldset class="current" data-step="1"><h2>Who is the client?</h2><p class="muted small" style="margin-bottom:18px">Their business name, and the web address of their online shop.</p>
<div class="stack-gap" style="margin:0">
<label>Business name<input name="name" required value="${esc(v.name ?? "")}" placeholder="SOSU Cosmetics" autofocus></label>
<label>Their online store <span class="hint">Optional. Leave it empty to only watch the market; add it later for price advice.</span><input name="store" value="${esc(v.store ?? "")}" placeholder="https://sosucosmetics.com" inputmode="url"></label>
</div></fieldset>

<fieldset data-step="2"><h2>Who are their competitors?</h2><p class="muted small" style="margin-bottom:18px">One store per box. A regional site such as <code>brand.com/ie</code> is fine and decides the prices and currency read. Most brands need 2 to 5.</p>
<div class="comp-list" id="comps">${comps.map(compRow).join("")}</div>
<p style="margin-top:10px"><button type="button" class="ghost small" id="add-comp">＋ Add another competitor</button></p>
<noscript><label>Or paste several, one per line<textarea name="competitors"></textarea></label></noscript>
</fieldset>

<fieldset data-step="3"><h2>How should they price?</h2><p class="muted small" style="margin-bottom:18px">Used for the price advice in their report. You can change it any time.</p>
<div class="choice">${radio("beat", "Beat the cheapest rival", "Suggest a price just under the lowest competitor.")}${radio("match", "Match the cheapest rival", "Suggest the same price as the lowest competitor.")}${radio("premium", "Stay premium", "Keep a set percentage above the market.")}</div>
<div class="row" style="margin-top:16px"><label>Never go below this margin <span class="hint">Only used once costs are known.</span><input name="minMarginPercent" type="number" min="0" max="95" step="1" value="${esc(v.minMarginPercent ?? "30")}"></label></div>
<label class="check" style="margin-top:16px"><input type="checkbox" name="autoConfirm" value="1"${v.autoConfirm === false ? "" : " checked"}><span><b>Pair very close matches for me</b><br><span class="muted small">When a rival sells what looks like the same product (95% match or better), confirm the pair automatically. You can undo any pair.</span></span></label>
<div class="review" id="review" style="margin-top:20px" hidden></div>
</fieldset>

<div class="nav-btns"><button type="button" class="ghost" id="back" hidden>← Back</button><span></span><button type="button" id="next">Continue →</button><button type="submit" id="finish">Add client and start the first check</button></div>
</form></div>
<script>
(function () {
  var form = document.getElementById("wizard"), sets = form.querySelectorAll("fieldset"), bars = document.querySelectorAll(".progress span");
  var F = function (n) { return form.elements.namedItem(n); };
  var back = document.getElementById("back"), next = document.getElementById("next"), finish = document.getElementById("finish"), step = 0;
  function host(u) { try { return new URL(/^https?:/i.test(u) ? u : "https://" + u).host.replace(/^www\\./, ""); } catch (e) { return u; } }
  function esc(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  function show(i) {
    step = i;
    sets.forEach(function (f, k) { f.classList.toggle("current", k === i); });
    bars.forEach(function (b, k) { b.classList.toggle("on", k <= i); });
    back.hidden = i === 0; next.hidden = i === sets.length - 1; finish.hidden = i !== sets.length - 1;
    if (i === sets.length - 1) {
      var comps = [].slice.call(form.querySelectorAll('[name="competitor"]')).map(function (x) { return x.value.trim(); }).filter(Boolean);
      var r = document.getElementById("review"); r.hidden = false;
      r.innerHTML = "<div><dt>Client</dt><dd>" + esc(F("name").value || "—") + "</dd></div><div><dt>Their store</dt><dd>" + esc(F("store").value ? host(F("store").value) : "Not yet (market view only)") + "</dd></div><div><dt>Competitors</dt><dd>" + (comps.length ? comps.map(function (c) { return esc(host(c)); }).join(", ") : "None yet") + "</dd></div>";
    }
    var first = sets[i].querySelector("input"); if (first && i > 0) first.focus();
  }
  function valid() {
    if (step === 0 && !F("name").value.trim()) { F("name").focus(); F("name").style.borderColor = "var(--bad)"; return false; }
    return true;
  }
  next.onclick = function () { if (valid()) show(step + 1); };
  back.onclick = function () { show(step - 1); };
  form.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target.tagName === "INPUT" && step < sets.length - 1) { e.preventDefault(); next.click(); } });
  document.getElementById("add-comp").onclick = function () {
    var list = document.getElementById("comps"), row = list.firstElementChild.cloneNode(true);
    row.querySelector("input").value = ""; row.querySelector("input").placeholder = "https://competitor.com"; list.appendChild(row); row.querySelector("input").focus();
  };
  document.getElementById("comps").addEventListener("click", function (e) {
    var b = e.target.closest("[data-remove]"); if (!b) return;
    var list = document.getElementById("comps");
    if (list.children.length > 1) b.parentNode.remove(); else b.parentNode.querySelector("input").value = "";
  });
  show(0);
})();
</script>`,
    { admin: true, nav: "new", clients: sidebar, error },
  );
}

export function helpPage(sidebar: Layout["clients"]): string {
  const qa = (q: string, a: string) => `<div style="padding:14px 0;border-bottom:1px solid var(--line)"><h3>${q}</h3><p class="muted" style="margin:0">${a}</p></div>`;
  return page(
    "How it works · Undercut",
    `<div class="head"><div><h1>How Undercut works</h1><p class="sub">A plain guide to what the app does and how to run a client.</p></div></div>
<section class="card"><header><div><h2>The four steps</h2><p>Everything after step 1 runs by itself.</p></div></header>${HOW_STEPS}</section>
<section class="card"><h2>Common questions</h2>
${qa("What does the client see?", "A private report link, no account needed. If their own store is added and products are paired, it shows which prices to change, where rivals undercut them, money at stake and a promotion forecast. Without their store it shows a market view of the competitors: price ranges, offers, promotions and range gaps.")}
${qa("What is a product pair?", "A link between one of the client's products and a rival product it competes with, such as their 30 ml serum and a rival's 30 ml serum. Price advice is only given for paired products. Undercut suggests pairs from look-alike names; very close ones are confirmed automatically if you chose that when adding the client.")}
${qa("Their products don't match anything. What now?", "Own-brand ranges often don't sell the same items. Use Pair by hand on the client's page: paste the address of their product page and the rival product page it competes with.")}
${qa("When are stores checked?", "Every morning at 04:00 UTC, and straight away when you add a store or press Check now. Large stores take a few minutes. Alerts and Shopify figures update at 06:00 UTC.")}
${qa("Where do costs and sales come from?", "From Shopify if the client connects it (read-only), or from a CSV you paste on the client's page. Without them, the report still works but can't put money figures on each move.")}
${qa("A store says it failed. Why?", "Usually the address is wrong, the site blocks automated visits, or it was down. Check the address opens in a browser, then press Check now.")}
</section>`,
    { admin: true, nav: "help", clients: sidebar },
  );
}

// ---------- one client ----------

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
  /** Other clients, for the sidebar. */
  sidebar?: Layout["clients"];
}

export function clientPage(d: ClientPageData, flash: { notice?: string | null; error?: string | null }): string {
  const c = d.client;
  const id = esc(c.id);
  const reportUrl = `${d.baseUrl}/r/${c.reportToken}`;
  const money = (p?: ProductSnapshot) => (p ? formatCents(p.priceCents, p.currency ?? d.currency) : "—");
  const merchant = d.stores.find((s) => s.kind === "merchant");
  const competitors = d.stores.filter((s) => s.kind === "competitor");
  const checking = d.stores.filter((s) => !s.lastCheckedAt && !s.lastError);
  const failing = d.stores.filter((s) => s.lastError);
  const lastChecked = d.stores.map((s) => s.lastCheckedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
  const row: ClientRow = {
    client: c,
    merchant,
    competitors: competitors.length,
    confirmedPairs: d.confirmed.length,
    suggestedPairs: d.suggestedTotal,
    checking: checking.length,
    failing: failing.length,
    lastCheckedAt: lastChecked ? new Date(lastChecked) : undefined,
  };
  const status = nextStep(row);
  const autoAt = c.settings.autoConfirmAbove;

  // Setup tracker: shown until the client is fully live, then folded away.
  type T = { state: "done" | "now" | "todo" | "problem"; title: string; text: string; action?: string };
  const storesStep: T =
    d.stores.length === 0
      ? { state: "now", title: "Add their stores", text: "Their own shop and the competitors they watch.", action: `<a class="btn small" href="#stores">Add stores</a>` }
      : { state: "done", title: "Stores added", text: `${merchant ? "Their store and " : "No store of their own yet, "}${competitors.length} competitor${competitors.length === 1 ? "" : "s"}.` };
  const checkStep: T =
    d.stores.length === 0
      ? { state: "todo", title: "First check", text: "Starts as soon as stores are added." }
      : checking.length
        ? { state: "now", title: "Reading every product", text: `${d.stores.length - checking.length} of ${d.stores.length} stores done. This page refreshes by itself.` }
        : failing.length
          ? { state: "problem", title: "Some stores couldn't be read", text: failing.map((s) => s.name).join(", ") + ". Check the address, then check again.", action: `<form class="inline" method="post" action="/clients/${id}/check"><button class="small" type="submit">Check again</button></form>` }
          : { state: "done", title: "First check done", text: `${d.stores.reduce((n, s) => n + s.products, 0).toLocaleString("en-IE")} products read across ${d.stores.length} stores.` };
  const pairStep: T = !merchant
    ? { state: "todo", title: "Pair products", text: "Needs their own store. Until then the report shows the market view.", action: `<a class="btn small ghost" href="#stores">Add their store</a>` }
    : d.confirmed.length > 0
      ? { state: "done", title: "Products paired", text: `${d.confirmed.length} pair${d.confirmed.length === 1 ? "" : "s"} confirmed${d.suggestedTotal ? `, ${d.suggestedTotal} more suggested` : ""}.` }
      : checking.length
        ? { state: "todo", title: "Pair products", text: autoAt ? `Close matches will be paired automatically after the check.` : "Suggestions appear after the check." }
        : d.suggestedTotal
          ? { state: "now", title: "Confirm the product pairs", text: `${d.suggestedTotal} look-alike product${d.suggestedTotal === 1 ? "" : "s"} found. Confirm the right ones.`, action: `<a class="btn small" href="#pairs">Review pairs</a>` }
          : { state: "now", title: "Pair products by hand", text: "No look-alikes found, which is normal for own-brand ranges.", action: `<a class="btn small" href="#pair-hand">Pair by hand</a>` };
  const shareStep: T = {
    state: checking.length || d.stores.length === 0 ? "todo" : "now",
    title: "Share the report",
    text: "A private link, no login needed. It updates every morning.",
    action: `<button class="small ghost" data-copy="${esc(reportUrl)}">Copy link</button>`,
  };
  const track = [storesStep, checkStep, pairStep, shareStep];
  const live = storesStep.state === "done" && checkStep.state === "done" && (pairStep.state === "done" || !merchant);
  const icon = (t: T, i: number) => (t.state === "done" ? "✓" : t.state === "problem" ? "!" : t.state === "now" && t === checkStep ? '<span class="spin"></span>' : String(i + 1));
  const tracker = `<ol class="track">${track
    .map((t, i) => `<li class="${t.state}"><span class="ic">${icon(t, i)}</span><div><h3>${esc(t.title)}</h3><p>${esc(t.text)}</p></div><div>${t.action ?? ""}</div></li>`)
    .join("")}</ol>`;

  const overview = `<section class="anchor" id="overview"><div class="grid2" style="margin-bottom:20px">
<section class="card"><header><div><h2>${live ? "Status" : "Getting set up"}</h2><p>${esc(status.next)}</p></div>${pill(status.tone, status.status, checking.length > 0)}</header>
${tracker}</section>
<section class="card"><header><div><h2>Client report</h2><p>Send this link to ${esc(c.name)}. Anyone with it can read the report, so share it only with them.</p></div></header>
<div class="linkbox"><span class="mono">${esc(reportUrl)}</span><button class="small" data-copy="${esc(reportUrl)}">Copy</button></div>
<div class="actions" style="margin-top:14px"><a class="btn small ghost" href="${esc(reportUrl)}" target="_blank" rel="noreferrer">Open report ↗</a>
<form class="inline" method="post" action="/clients/${id}/check"><button class="small ghost" type="submit">Check all stores now</button></form></div>
<p class="small muted" style="margin:14px 0 0">${merchant && d.confirmed.length ? "Shows the weekly report with price advice, plus the market view." : "Shows the market view of their competitors. Price advice appears once their store is added and products are paired."} Last check ${esc(ago(row.lastCheckedAt))}.</p>
</section></div></section>`;

  const stores = d.stores.length
    ? `<div class="wrap"><table><thead><tr><th>Store</th><th>Role</th><th class="num">Products</th><th>Last check</th><th></th></tr></thead><tbody>
${d.stores
  .map(
    (s) => `<tr><td><div class="prod"><a href="${esc(s.url)}" rel="noreferrer" target="_blank">${esc(s.name)}</a><small class="mono">${esc(s.url)}</small></div></td>
<td>${s.kind === "merchant" ? pill("good", "their store") : pill("grey", "competitor")}</td>
<td class="num">${s.products.toLocaleString("en-IE")}</td>
<td class="small">${s.lastError ? `${pill("bad", "couldn't read")}<div class="muted small" title="${esc(s.lastError)}" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.lastError)}</div>` : s.lastCheckedAt ? `<span title="${esc(when(s.lastCheckedAt))}">${esc(ago(s.lastCheckedAt))}</span>` : pill("grey", "reading", true)}</td>
<td class="num"><form class="inline" method="post" action="/clients/${id}/stores/${esc(s.id)}/remove"><button class="quiet small" type="submit" title="Remove ${esc(s.name)}">Remove</button></form></td></tr>`,
  )
  .join("")}</tbody></table></div>`
    : '<div class="empty">No stores yet. Add their own store and a competitor below.</div>';

  const opt = (v: string, cur: string, label: string) => `<option value="${v}"${v === cur ? " selected" : ""}>${label}</option>`;

  const storesSection = `<section class="card anchor" id="stores"><header><div><h2>Stores</h2><p>Their own shop and the competitors Undercut reads every morning.</p></div></header>${stores}
<form class="row" method="post" action="/clients/${id}/stores" style="margin-top:18px;padding-top:18px;border-top:1px solid var(--line)">
<label>Add a store<input name="url" required placeholder="https://competitor.com" inputmode="url"></label>
<label>Name (optional)<input name="name" placeholder="Taken from the address"></label>
<label class="shrink" style="min-width:170px">Role<select name="role">${merchant ? "" : opt("merchant", "competitor", "Their own store")}${opt("competitor", "competitor", "Competitor")}</select></label>
<div class="shrink"><button type="submit">Add store</button></div></form></section>`;

  const pairRow = (m: ClientPageData["suggested"][number], actions: string) =>
    `<tr><td><div class="prod">${m.mine ? `<a href="${esc(m.mine.url)}" rel="noreferrer" target="_blank">${esc(m.mine.title)}</a>` : esc(m.merchantExternalId)}<small>${money(m.mine)}</small></div></td>
<td><div class="prod">${m.theirs ? `<a href="${esc(m.theirs.url)}" rel="noreferrer" target="_blank">${esc(m.theirs.title)}</a>` : esc(m.competitorExternalId)}<small>${esc(m.storeName)} · ${money(m.theirs)}</small></div></td>
<td class="num"><span class="pill conf ${m.confidence >= 0.9 ? "good" : m.confidence >= 0.75 ? "" : "warn"}">${Math.round(m.confidence * 100)}%</span></td><td class="num" style="white-space:nowrap">${actions}</td></tr>`;
  const matchForm = (m: ProductMatch, action: string, label: string, cls = "ghost small") =>
    `<form class="inline" method="post" action="/clients/${id}/matches"><input type="hidden" name="key" value="${esc(JSON.stringify([m.merchantExternalId, m.competitorStoreId, m.competitorExternalId]))}"><input type="hidden" name="status" value="${action}"><button class="${cls}" type="submit">${label}</button></form>`;
  const strong = d.suggested.filter((m) => m.confidence >= 0.9).length;

  const suggested = d.suggested.length
    ? `<div class="wrap"><table><thead><tr><th>Their product</th><th>Rival product</th><th class="num">Match</th><th></th></tr></thead><tbody>
${d.suggested.map((m) => pairRow(m, `${matchForm(m, "confirmed", "✓ Confirm", "small")} ${matchForm(m, "rejected", "Not a match", "quiet small")}`)).join("")}</tbody></table></div>
${d.suggestedTotal > d.suggested.length ? `<p class="small muted" style="margin-top:10px">Showing the ${d.suggested.length} closest of ${d.suggestedTotal} suggestions.</p>` : ""}`
    : `<div class="empty">${merchant ? (checking.length ? "Suggestions appear once the first check finishes." : "No suggestions waiting. New ones appear after each check when products look alike.") : "Add their own store first; pairs link their products to rival products."}</div>`;

  const confirmed = d.confirmed.length
    ? `<details><summary>${d.confirmed.length} confirmed pair${d.confirmed.length === 1 ? "" : "s"}</summary><div class="wrap" style="margin-top:10px"><table><tbody>
${d.confirmed.map((m) => pairRow(m, matchForm(m, "rejected", "Unpair", "quiet small"))).join("")}</tbody></table></div></details>`
    : '<p class="muted small" style="margin:0">No confirmed pairs yet. Until there are, the report shows the competitor market view.</p>';

  const pairsSection = `<section class="card anchor" id="pairs"><header><div><h2>Product pairs</h2><p>Which of their products competes with which rival product. Price advice is given only for paired products.</p></div>
${strong ? `<form class="inline" method="post" action="/clients/${id}/confirm-above"><input type="hidden" name="min" value="0.9"><button class="small" type="submit">Confirm all ${strong} strong matches (90%+)</button></form>` : ""}</header>
${autoAt ? `<p class="small" style="margin:-6px 0 14px">${pill("good", "Auto-pairing on")} <span class="muted">Matches of ${Math.round(autoAt * 100)}% or better are confirmed after each check.</span></p>` : ""}
${suggested}
<div style="margin-top:18px">${confirmed}</div>
<div class="anchor" id="pair-hand" style="margin-top:22px;padding-top:18px;border-top:1px solid var(--line)"><h3>Pair by hand</h3>
<p class="small muted">For own-brand ranges that don't sell the same items: paste their product page and the rival product page it competes with.</p>
<form class="row" method="post" action="/clients/${id}/pair">
<label>Their product page<input name="yours" required placeholder="${esc(merchant ? `${merchant.url}/products/...` : "https://their-store.com/products/...")}"></label>
<label>Rival product page<input name="theirs" required placeholder="https://competitor.com/products/..."></label>
<div class="shrink"><button type="submit">Pair</button></div></form>
<details style="margin-top:14px"><summary>Confirm by match score</summary><form class="row" method="post" action="/clients/${id}/confirm-above" style="margin-top:10px">
<label>Confirm every suggestion at or above<input name="min" type="number" step="0.05" min="0.5" max="1" value="0.85"></label><div class="shrink"><button class="ghost" type="submit">Confirm</button></div></form></details>
</div></section>`;

  const p = d.config.pricing;
  const settingsSection = `<section class="card anchor" id="settings"><header><div><h2>Pricing rules and alerts</h2><p>How the report decides which prices to suggest, and where urgent alerts go.</p></div></header>
<form class="stack" method="post" action="/clients/${id}/settings">
<div class="row"><label>Strategy<select name="strategy">${opt("beat", p.strategy, "Beat the cheapest rival")}${opt("match", p.strategy, "Match the cheapest rival")}${opt("premium", p.strategy, "Stay a set % above")}</select></label>
<label>Beat by %<input name="beatByPercent" type="number" step="0.5" min="0" value="${p.beatByPercent}"></label>
<label>Premium %<input name="premiumPercent" type="number" step="0.5" min="0" value="${p.premiumPercent}"></label></div>
<div class="row"><label>Minimum margin %<input name="minMarginPercent" type="number" step="1" min="0" value="${p.minMarginPercent}"></label>
<label>Largest single change %<input name="maxChangePercent" type="number" step="1" min="1" value="${p.maxChangePercent}"></label>
<label>Price endings<select name="rounding">${opt("match", p.rounding, "Like the current price")}${opt("99", p.rounding, ".99")}${opt("95", p.rounding, ".95")}${opt("none", p.rounding, "As computed")}</select></label></div>
<label class="check"><input type="checkbox" name="autoConfirm" value="1"${autoAt ? " checked" : ""}><span>Pair very close matches automatically (95% or better)</span></label>
<input type="hidden" name="autoConfirmField" value="1">
<label>Slack or webhook URL for urgent alerts <span class="hint">Optional. A message is sent when a rival makes a move worth acting on.</span><input name="webhookUrl" type="url" value="${esc(d.config.alerts.webhookUrl ?? "")}" placeholder="https://hooks.slack.com/services/..."></label>
<label>Business name<input name="name" value="${esc(c.name)}" required></label>
<div><button type="submit">Save changes</button></div></form>
<div class="actions" style="margin-top:18px;padding-top:18px;border-top:1px solid var(--line)">
<form class="inline" method="post" action="/clients/${id}/active"><input type="hidden" name="active" value="${c.active ? "0" : "1"}"><button class="ghost small" type="submit">${c.active ? "Pause daily checks" : "Resume daily checks"}</button></form>
<form class="inline" method="post" action="/clients/${id}/rotate-link"><button class="ghost small" type="submit">Replace the report link</button></form></div></section>`;

  const shopify = !d.shopifyEnabled
    ? '<p class="muted small">Shopify connection is not configured on this deployment yet (needs SHOPIFY_API_KEY and SHOPIFY_API_SECRET).</p>'
    : c.shopify?.hasToken
      ? `<p>${pill("good", "connected")} <span class="mono">${esc(c.shopify.shop)}</span></p>
<p class="small muted">Read-only access: ${esc(c.shopify.scopes ?? "")}. Costs and weekly sales last synced ${esc(when(c.shopify.syncedAt))}.</p>
<form class="inline" method="post" action="/clients/${id}/shopify-sync"><button class="ghost small" type="submit">Sync costs and sales now</button></form>`
      : `<p class="small muted">Lets Undercut read product costs and recent sales (never change anything), so the report can put money figures on each competitor move.</p>
<form class="row" method="get" action="/shopify/install"><input type="hidden" name="client" value="${id}">
<label>Shop address<input name="shop" placeholder="brand.myshopify.com" required></label><div class="shrink"><button type="submit">Connect Shopify</button></div></form>
<p class="small muted" style="margin-top:12px">Or send the client this link to approve it themselves:</p>
<div class="linkbox"><span class="mono">${esc(`${d.baseUrl}/shopify/install?client=${c.id}&shop=`)}their-shop.myshopify.com</span><button class="small ghost" data-copy="${esc(`${d.baseUrl}/shopify/install?client=${c.id}&shop=`)}">Copy</button></div>`;

  const dataSection = `<section class="card anchor" id="data"><header><div><h2>Costs and sales</h2><p>Optional. With these, the report shows money at stake and protects their margin.</p></div></header>
<div class="grid2"><div><h3>Shopify (read-only)</h3>${shopify}</div>
<div><h3>Or paste a CSV</h3><p class="small muted">Header row: <code>url</code> (or <code>id</code> or <code>title</code>), then <code>cost</code> and/or <code>units_per_week</code>.</p>
<form class="stack" method="post" action="/clients/${id}/economics"><textarea name="csv" placeholder="url,cost,units_per_week&#10;https://their-store.com/products/serum,9.50,12"></textarea><div><button class="ghost small" type="submit">Import figures</button></div></form></div></div></section>`;

  const dangerSection = `<section class="card anchor" id="remove"><details><summary>Remove this client</summary>
<form class="row" method="post" action="/clients/${id}/delete" style="margin-top:14px"><label>Type the client id <code>${id}</code> to confirm<input name="confirm" required></label>
<div class="shrink"><button class="danger" type="submit">Remove client</button></div></form>
<p class="small muted" style="margin-top:10px">Their pairs and settings go. Price history of shared stores stays for other clients.</p></details></section>`;

  const tab = (href: string, label: string, count?: number) => `<a href="${href}">${label}${count ? `<span class="count">${count}</span>` : ""}</a>`;

  return page(
    `${c.name} · Undercut`,
    `<div class="head"><div><p class="small" style="margin:0 0 6px"><a href="/">← Dashboard</a></p><h1>${esc(c.name)}</h1>
<p class="sub">${merchant ? `<a href="${esc(merchant.url)}" target="_blank" rel="noreferrer">${esc(merchant.url.replace(/^https?:\/\/(www\.)?/, ""))}</a> · ` : ""}${competitors.length} competitor${competitors.length === 1 ? "" : "s"} · checked ${esc(ago(row.lastCheckedAt))}</p></div>
<div class="actions"><a class="btn ghost" href="${esc(reportUrl)}" target="_blank" rel="noreferrer">Open report ↗</a><button class="ghost" data-copy="${esc(reportUrl)}">Copy report link</button></div></div>
<nav class="tabs">${tab("#overview", "Overview")}${tab("#stores", "Stores", d.stores.length)}${tab("#pairs", "Product pairs", d.suggestedTotal)}${tab("#settings", "Pricing and alerts")}${tab("#data", "Costs and sales")}</nav>
${overview}${storesSection}${pairsSection}<div class="grid2" style="margin-bottom:20px">${settingsSection.replace('class="card anchor"', 'class="card anchor" style="margin:0"')}${dataSection.replace('class="card anchor"', 'class="card anchor" style="margin:0"')}</div>${dangerSection}`,
    { admin: true, nav: { client: c.id }, clients: d.sidebar, refresh: checking.length ? 15 : undefined, ...flash },
  );
}

// ---------- public pages ----------

export function waitingPage(name: string): string {
  return page(
    `${name} · Undercut`,
    `<div style="text-align:center;margin-bottom:22px"><span class="logo" style="justify-content:center"><i>◆</i>Undercut</span></div>
<section class="card" style="text-align:center;padding:34px"><h1>${esc(name)}</h1><p class="sub" style="margin:8px auto 18px">We're reading every product on your competitors' websites for the first time. Your report appears here when that finishes, usually within the hour.</p>
<p>${pill("grey", "First check running", true)}</p><p class="small muted" style="margin:16px 0 0">This page refreshes by itself.</p></section>`,
    { refresh: 60 },
  );
}

export function notFoundPage(): string {
  return page("Not found · Undercut", `<section class="card"><h1>Not found</h1><p class="muted">That page doesn't exist, or the link has been replaced. If someone sent you this link, ask them for a new one.</p></section>`);
}

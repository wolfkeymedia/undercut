import type { SiteHealthData } from "../health/check.js";
import { AREA_LABEL, assessHealth, seconds, type Finding, type HealthReport } from "../health/score.js";
import { REPORT_CSS } from "./html.js";
import { SUMMARY_CSS } from "./summary.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const date = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const PRIORITY: Record<Finding["priority"], { label: string; tone: string }> = {
  high: { label: "Fix first", tone: "bad" },
  medium: { label: "Worth fixing", tone: "neutral" },
  low: { label: "Nice to fix", tone: "muted" },
};
const STATUS = { good: { tone: "good", mark: "✓" }, warn: { tone: "neutral", mark: "!" }, bad: { tone: "bad", mark: "!" }, off: { tone: "muted", mark: "–" } } as const;

export interface HealthPageOptions {
  clientName: string;
  data?: SiteHealthData;
  /** A check is under way (the first one, or a refresh). */
  running?: boolean;
  now?: Date;
}

/** The "Site health" page of a client's report: findings as cards, then the detail behind them. */
export function renderHealth(options: HealthPageOptions): string {
  const { data } = options;
  const title = `${options.clientName} · Site health`;
  if (!data) {
    return page(
      title,
      `<header><div><div class="brand">Undercut</div><h1>Site health</h1></div></header>
       <section><p>${options.running ? "We're checking your website now. It takes a few minutes; refresh this page shortly." : "Your first site check hasn't run yet. It runs with the daily checks."}</p></section>`,
    );
  }
  const now = options.now ?? new Date();
  const report = assessHealth(data, now);
  const checked = new Date(data.checkedAt);

  const tiles = report.areas
    .map((a) => {
      const s = STATUS[a.status];
      return `<div class="area"><span class="dot ${s.tone}">${s.mark}</span><div><div class="name">${esc(a.label)}</div><div class="sub">${esc(a.line)}</div></div></div>`;
    })
    .join("");

  const cards = report.findings.map(card).join("");

  return page(
    title,
    `<header>
      <div><div class="brand">Undercut</div><h1>Site health: ${esc(new URL(data.site).host)}</h1></div>
      <div class="meta">Checked ${esc(date(checked))} · ${data.pages.length} pages read${options.running ? " · A fresh check is running" : ""}</div>
    </header>

    <div class="health-top">
      <div class="score-tile ${report.score >= 85 ? "good" : report.score >= 60 ? "neutral" : "bad"}"><span class="label">Health score</span><span class="value">${report.score}</span><span class="note">${esc(scoreWords(report))}</span></div>
      <div class="areas">${tiles}</div>
    </div>

    <div>
      <h2 class="moves-h">Things to fix</h2>
      ${cards ? `<div class="moves">${cards}</div>` : `<section><p class="empty">Nothing to fix. Your site passed every check.</p></section>`}
    </div>

    ${trackingSection(data)}
    ${speedSection(data)}

    <footer>Tracking: we confirm the Meta pixel and Google tags are on your pages and that their scripts load. We can't see whether events such as purchases fire; check that in Meta Events Manager and Google Analytics. Broken pages: we read up to ${data.crawlLimit} pages from your menu and sitemap${data.crawlCutShort ? " (this check stopped early at the time limit)" : ""}. Speed and mobile come from Google PageSpeed Insights on a mid-range phone.</footer>`,
  );
}

function card(f: Finding): string {
  const p = PRIORITY[f.priority];
  const examples = f.examples?.length
    ? `<details><summary>Where (${f.examples.length})</summary><ul>${f.examples.slice(0, 8).map((e) => `<li>${esc(e)}</li>`).join("")}${f.examples.length > 8 ? `<li>and ${f.examples.length - 8} more</li>` : ""}</ul></details>`
    : "";
  return `<article class="move">
    <div class="tags"><span class="pill ${p.tone}">${p.label}</span><span class="area-tag">${esc(AREA_LABEL[f.area])}</span></div>
    <h3>${esc(f.issue)}</h3>
    <div class="impact"><span class="label">How to fix it</span><div>${esc(f.fix)}</div></div>
    ${examples}
  </article>`;
}

function scoreWords(r: HealthReport): string {
  const high = r.findings.filter((f) => f.priority === "high").length;
  if (r.findings.length === 0) return "Everything we check is in order.";
  return high ? `${high} to fix first, ${r.findings.length - high} more after.` : `${r.findings.length} smaller things to tidy up.`;
}

function trackingSection(data: SiteHealthData): string {
  const yes = (on: boolean) => (on ? `<span class="good-t">Found</span>` : `<span class="bad-t">Not found</span>`);
  const rows = data.tracking.pages
    .map((p) => {
      if (!p.tags) return `<tr><td>${esc(p.label)}</td><td colspan="2" class="sub">Couldn't read this page${p.status ? ` (HTTP ${p.status})` : ""}.</td></tr>`;
      const meta = p.tags.metaScript || p.tags.metaPixelIds.length > 0;
      const google = p.tags.googleScript || p.tags.googleIds.length > 0;
      return `<tr><td><a href="${esc(p.url)}">${esc(p.label)}</a></td><td>${yes(meta)}${p.tags.metaPixelIds.length ? `<div class="sub">${esc(p.tags.metaPixelIds.join(", "))}</div>` : ""}</td><td>${yes(google)}${p.tags.googleIds.length ? `<div class="sub">${esc(p.tags.googleIds.join(", "))}</div>` : ""}</td></tr>`;
    })
    .join("");
  const loads = (v: boolean | undefined) => (v === undefined ? "" : v ? "loads" : "doesn't load");
  const scripts = [data.tracking.metaScriptLoads !== undefined ? `Meta's script ${loads(data.tracking.metaScriptLoads)}` : "", data.tracking.googleScriptLoads !== undefined ? `Google's script ${loads(data.tracking.googleScriptLoads)}` : ""].filter(Boolean);
  return `<section id="tracking"><h2>Tracking tags on key pages</h2>
    <p class="explain">This shows whether the tags are on the page. It doesn't show whether events such as add-to-cart or purchase fire.</p>
    <div class="scroll"><table><thead><tr><th>Page</th><th>Meta pixel</th><th>Google tag</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${scripts.length ? `<p class="sub" style="margin-top:10px">${esc(scripts.join(". "))}.</p>` : ""}
  </section>`;
}

function speedSection(data: SiteHealthData): string {
  if (!data.speed.connected)
    return `<section id="speed"><h2>Speed and mobile</h2><p class="empty"><span class="pill muted">Not connected</span> Speed checks use Google PageSpeed Insights, which isn't connected yet. The other checks above still ran.</p></section>`;
  if (!data.speed.results.length) return `<section id="speed"><h2>Speed and mobile</h2><p class="empty">Google couldn't test your pages this time. We'll try again on the next check.</p></section>`;
  const v = (n: number | undefined, f: (n: number) => string) => (n === undefined ? "–" : f(n));
  const rows = data.speed.results
    .map((r) => {
      const name = new URL(r.url).pathname === "/" ? "Home page" : "Top product page";
      return `<tr><td><a href="${esc(r.url)}">${name}</a></td><td class="num">${v(r.score, (n) => `${n}/100`)}</td><td class="num">${v(r.field?.lcpMs ?? r.lab.lcpMs, seconds)}</td><td class="num">${v(r.field?.inpMs, (n) => `${Math.round(n)} ms`)}</td><td class="num">${v(r.field?.cls ?? r.lab.cls, (n) => n.toFixed(2))}</td><td>${r.field?.verdict ? esc(r.field.verdict.toLowerCase()) : '<span class="sub">Not enough visits yet</span>'}</td></tr>`;
    })
    .join("");
  return `<section id="speed"><h2>Speed and mobile</h2>
    <p class="explain">Google's Core Web Vitals on a phone. Good is a main-content time under 2.5 s, tap response under 200 ms and layout shift under 0.10. Real-visitor figures are used where Google has them.</p>
    <div class="scroll"><table><thead><tr><th>Page</th><th class="num">Score</th><th class="num">Main content</th><th class="num">Tap response</th><th class="num">Layout shift</th><th>Real visitors</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${REPORT_CSS}${SUMMARY_CSS}${HEALTH_CSS}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>
`;
}

/** The line about site health on the report's front page. */
export function healthTeaser(data: SiteHealthData | undefined, href: string, now = new Date()): string {
  if (!data) return `<a class="health-teaser" href="${esc(href)}"><span class="pill muted">Site health</span><span>We're checking your website for broken pages, tracking, speed and SEO.</span><span class="go">See site health</span></a>`;
  const r = assessHealth(data, now);
  const high = r.findings.filter((f) => f.priority === "high").length;
  const words = r.findings.length === 0 ? "Your website passed every check." : `${r.findings.length} thing${r.findings.length === 1 ? "" : "s"} to fix on your website${high ? `, ${high} of them first` : ""}.`;
  return `<a class="health-teaser" href="${esc(href)}"><span class="pill ${high ? "bad" : r.findings.length ? "neutral" : "good"}">Site health ${r.score}/100</span><span>${esc(words)}</span><span class="go">See site health</span></a>`;
}

export const HEALTH_CSS = `
.health-top { display: grid; grid-template-columns: minmax(180px, 220px) 1fr; gap: 14px; }
@media (max-width: 640px) { .health-top { grid-template-columns: 1fr; } }
.score-tile { border-radius: 14px; padding: 18px; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--line); background: var(--t1); }
.score-tile .label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.score-tile .value { font-size: 2.6rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
.score-tile.good .value { color: var(--good); } .score-tile.bad .value { color: var(--bad); } .score-tile.neutral .value { color: var(--neutral); }
.score-tile .note { font-size: 0.85rem; color: var(--muted); }
.score-tile.good, .score-tile.bad, .score-tile.neutral { background: var(--t1); }
.areas { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.area { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; display: flex; gap: 10px; align-items: start; }
.area .name { font-weight: 600; }
.area .dot { flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; }
.move .tags { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.move .area-tag { font-size: 0.78rem; color: var(--muted); font-weight: 500; }
.move .impact div { font-size: 0.9rem; }
.move details { font-size: 0.85rem; color: var(--muted); }
.move details summary { cursor: pointer; color: var(--accent); font-weight: 500; }
.move details ul { margin: 6px 0 0; padding-left: 18px; word-break: break-word; }
`;

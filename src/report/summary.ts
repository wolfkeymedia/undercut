import { buildSummary, type SuggestedMove } from "../insights/summary.js";
import type { Insights } from "../pipeline.js";
import { REPORT_CSS } from "./html.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const KIND: Record<SuggestedMove["kind"], { label: string; tone: string }> = {
  raise: { label: "Raise price", tone: "good" },
  cut: { label: "Cut price", tone: "bad" },
  hold: { label: "Hold price", tone: "neutral" },
  promo: { label: "Rival promotion", tone: "accent" },
};

/**
 * The first page of a client's report: a plain summary of what's going well
 * and what isn't, then one card per suggested move with its likely impact.
 * Everything else lives on the details page that `detailsHref` points to.
 */
export function renderSummary(insights: Insights, options: { weekOf: Date; detailsHref: string; generatedAt?: Date; sample?: boolean; /** The site health line, already rendered. */ healthHtml?: string }): string {
  const s = buildSummary(insights, { now: options.generatedAt });
  const week = options.weekOf.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const details = (anchor?: string) => `${esc(options.detailsHref)}${anchor ? `#${anchor}` : ""}`;
  const items = (list: string[]) => list.map((l) => `<li>${esc(l)}</li>`).join("");

  const cards = s.moves
    .map((m) => {
      const k = KIND[m.kind];
      const total = m.impact.total
        ? `<div class="big ${m.impact.totalCents !== undefined && m.impact.totalCents < 0 ? "bad-t" : "good-t"}">${esc(m.impact.total)}</div><div class="sub">${esc(m.impact.perUnit)}</div>`
        : `<div class="big">${esc(m.impact.perUnit)}</div>${m.impact.note ? `<div class="note">${esc(m.impact.note)}</div>` : ""}`;
      return `<article class="move">
        <span class="pill ${k.tone}">${k.label}</span>
        <h3>${m.url ? `<a href="${esc(m.url)}">${esc(m.title)}</a>` : esc(m.title)}</h3>
        <p class="why">${esc(m.why)}</p>
        <div class="impact"><span class="label">Potential impact</span>${total}</div>
        <a class="more" href="${details(m.detailsAnchor)}">See details</a>
      </article>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(insights.merchant.name)} · This week's moves</title>
<style>
${REPORT_CSS}${SUMMARY_CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <div><div class="brand">Undercut</div><h1>${esc(insights.merchant.name)}: week of ${esc(week)}</h1></div>
    <div class="meta">${options.sample ? `<span class="pill neutral">Sample data</span> ` : ""}Watching ${insights.competitors.length} competitors · <a href="${details()}">See full details</a></div>
  </header>

  <div class="summary">
    <section class="well"><h2>Doing well</h2><ul>${items(s.doingWell)}</ul></section>
    <section class="attn"><h2>Needs attention</h2><ul>${items(s.needsAttention)}</ul></section>
  </div>

  ${options.healthHtml ?? ""}

  <div>
    <h2 class="moves-h">Suggested moves</h2>
    ${cards ? `<div class="moves">${cards}</div>` : `<section><p class="empty">No moves to make this week. Your prices sit where your rules want them.</p></section>`}
    ${s.totalMoves > s.moves.length ? `<p class="sub" style="margin-top:12px">Showing the top ${s.moves.length} of ${s.totalMoves}. <a href="${details("prices")}">See them all</a></p>` : ""}
  </div>

  <footer>Totals use only your own weekly sales. We never guess a rival's sales, so where yours aren't connected you see the effect on each sale instead. <a href="${details()}">See details</a> for every price, gap and promotion behind these cards.</footer>
</div>
</body>
</html>
`;
}

export const SUMMARY_CSS = `
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.summary ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
.summary li { padding-left: 26px; position: relative; }
.summary li::before { position: absolute; left: 0; top: 1px; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; }
.summary .well { background: var(--t3); } .summary .well li::before { content: "✓"; background: var(--good-bg); color: var(--good); }
.summary .attn { background: var(--t4); } .summary .attn li::before { content: "!"; background: var(--bad-bg); color: var(--bad); }
.moves-h { margin-bottom: 12px; }
.moves { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.move { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 18px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 1px 2px rgba(30,34,51,.04), 0 6px 24px rgba(30,34,51,.05); }
.move .pill { align-self: start; }
.move h3 { margin: 2px 0 0; font-size: 1.02rem; line-height: 1.35; }
.move h3 a { color: var(--fg); text-decoration: none; } .move h3 a:hover { color: var(--accent); }
.move .why { margin: 0; color: var(--muted); font-size: 0.9rem; }
.move .impact { background: var(--muted-bg); border-radius: 10px; padding: 10px 12px; margin-top: auto; }
.move .impact .label { display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 2px; }
.move .big { font-weight: 700; font-variant-numeric: tabular-nums; }
.move .note { font-size: 0.82rem; color: var(--accent); margin-top: 2px; }
.move .more { font-size: 0.88rem; font-weight: 500; }
.pill.accent { background: var(--accent-bg); color: var(--accent); }
.health-teaser { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px 18px; color: var(--fg); text-decoration: none; box-shadow: 0 1px 2px rgba(30,34,51,.04), 0 6px 24px rgba(30,34,51,.05); }
.health-teaser:hover { border-color: var(--accent); }
.health-teaser .go { margin-left: auto; color: var(--accent); font-weight: 500; font-size: 0.9rem; }
`;

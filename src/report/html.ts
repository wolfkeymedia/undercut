import { describeItem } from "../brief/write.js";
import type { Config } from "../config.js";
import type { ProductPosition } from "../insights/position.js";
import { describePattern } from "../insights/promos.js";
import type { PriceGapAlert, TrackedPromo } from "../insights/reports.js";
import { formatCents } from "../money.js";
import type { Insights } from "../pipeline.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const KIND_LABEL: Record<string, string> = {
  price_drop: "Price cut",
  price_increase: "Price rise",
  out_of_stock: "Out of stock",
  back_in_stock: "Restocked",
  new_product: "New product",
  removed_product: "Removed",
  promo_started: "Promo",
  promo_ended: "Promo ended",
};

const POSITION_LABEL: Record<ProductPosition["position"], string> = {
  cheapest: "Cheapest",
  matched: "Level",
  undercut: "Undercut",
  no_rival_in_stock: "Rivals out of stock",
};

/**
 * The manager's weekly report as one self-contained HTML file: money at stake,
 * what to do, what changed, and where every product stands. Opens offline and
 * can be emailed or shared as is.
 */
export function renderReport(insights: Insights, config: Config, options: { weekOf: Date; generatedAt?: Date; sample?: boolean }): string {
  const money = (c: number) => formatCents(c, insights.currency);
  // The currency sign on its own, for headings: "€", "$", or the code when there is no sign.
  const cur = money(0).replace(/[\d.,\s]/g, "") || (insights.currency ?? "");
  const t = insights.scorecard.totals;
  const raises = insights.recommendations.filter((r) => r.action === "raise");
  const headroom = raises.reduce((s, r) => s + (r.weeklyMarginImpactCents ?? 0), 0);
  const week = options.weekOf.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const generated = (options.generatedAt ?? new Date()).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  const tiles = [
    tile("Sales at risk", t.revenueAtRiskCents > 0 ? money(t.revenueAtRiskCents) : "None", "per week, from cheaper rivals", t.revenueAtRiskCents > 0 ? "bad" : "good"),
    tile("Margin you could add", headroom > 0 ? money(headroom) : "None", `per week, ${raises.length} price ${raises.length === 1 ? "rise" : "rises"} where you're cheapest`, headroom > 0 ? "good" : ""),
    tile("Undercut products", String(t.undercut), `of ${t.matchedProducts} you sell against competitors`, t.undercut > 0 ? "bad" : "good"),
    tile("Changes spotted", String(insights.items.length), "at your competitors this week", ""),
  ].join("");

  const positionBar =
    t.matchedProducts > 0
      ? `<div class="bar" role="img" aria-label="Cheapest on ${t.cheapest}, level on ${t.matched}, undercut on ${t.undercut}, rivals out of stock on ${t.noRivalInStock}">
          ${seg(t.cheapest, t.matchedProducts, "good", "Cheapest")}${seg(t.matched, t.matchedProducts, "neutral", "Level")}${seg(t.undercut, t.matchedProducts, "bad", "Undercut")}${seg(t.noRivalInStock, t.matchedProducts, "muted", "Rivals out of stock")}
        </div>
        <div class="legend">${[
          legend("good", "Cheapest", t.cheapest),
          legend("neutral", "Level", t.matched),
          legend("bad", "Undercut", t.undercut),
          legend("muted", "Rivals out of stock", t.noRivalInStock),
        ].join("")}</div>`
      : `<p class="empty">Confirm product matches to see where you stand.</p>`;

  const indexes = insights.scorecard.indexes
    .map((ix) => {
      const diff = Math.round((ix.index - 100) * 10) / 10;
      const cls = diff > 0.5 ? "bad" : diff < -0.5 ? "good" : "neutral";
      const label = diff === 0 ? "level" : diff > 0 ? `${diff}% pricier` : `${-diff}% cheaper`;
      return `<tr><td>${esc(ix.storeName)}<div class="sub">${ix.comparedProducts} shared products</div></td><td class="num">${ix.index.toFixed(1)}</td><td><span class="pill ${cls}">You are ${label}</span></td></tr>`;
    })
    .join("");

  const actions = insights.recommendations
    .slice(0, 10)
    .map((r) => {
      const v = r.weeklyMarginImpactCents;
      // For a hold, the money is what holding saves compared with the rejected cut.
      const impact =
        v === undefined ? "—" : r.action === "hold" ? `saves ${money(-v)}` : `${v >= 0 ? "+" : "−"}${money(Math.abs(v))}`;
      const recommended =
        r.action === "hold"
          ? `<span class="pill neutral">Hold</span>`
          : `${r.action === "raise" ? "▲" : "▼"} ${money(r.recommendedCents)}`;
      return `<tr>
        <td><a href="${esc(r.url)}">${esc(r.title)}</a><div class="sub">${esc(r.reason)}</div></td>
        <td class="num">${money(r.currentCents)}</td>
        <td class="num strong">${recommended}</td>
        <td class="num">${r.marginPercent !== undefined ? `${r.marginPercent.toFixed(0)}%` : "—"}</td>
        <td class="num ${v !== undefined && (v > 0 || r.action === "hold") ? "good-t" : ""}">${impact}</td>
      </tr>`;
    })
    .join("");

  const changes = insights.items
    .slice(0, 12)
    .map(
      (i) => `<li><span class="chip ${chipClass(i.event.kind)}">${KIND_LABEL[i.event.kind]}</span>
        <div><p>${esc(describeItem(i, insights.currency))}</p>${i.suggestion ? `<p class="sub"><b>Suggested:</b> ${esc(i.suggestion)}</p>` : ""}</div></li>`,
    )
    .join("");

  const rows = insights.scorecard.positions
    .slice(0, 50)
    .map((p) => {
      const r = p.cheapestRival;
      const gap = r ? `${r.gapPercent > 0 ? "+" : ""}${r.gapPercent.toFixed(1)}%` : "—";
      return `<tr>
        <td>${esc(p.product.title)}</td>
        <td class="num">${money(p.product.priceCents)}</td>
        <td>${r ? `${esc(r.storeName)} <span class="num">${money(r.priceCents)}</span>` : "—"}</td>
        <td class="num">${gap}</td>
        <td><span class="pill ${p.position === "undercut" ? "bad" : p.position === "cheapest" ? "good" : p.position === "matched" ? "neutral" : "muted"}">${POSITION_LABEL[p.position]}</span></td>
        <td class="num">${p.revenueAtRiskCents ? money(p.revenueAtRiskCents) : "—"}</td>
      </tr>`;
    })
    .join("");

  const promos = insights.patterns
    .map((p) => describePattern(p, options.generatedAt ?? new Date()))
    .filter((s): s is string => Boolean(s))
    .map((s) => `<li>${esc(s)}</li>`)
    .join("");

  const moveRows = insights.priceMoves
    .map((m) => {
      const pct = `${m.changePercent > 0 ? "+" : ""}${m.changePercent.toFixed(1)}%`;
      const value = m.valueCents !== undefined ? `<span class="bad-t">${money(m.valueCents)}</span><div class="sub">sales at risk / wk</div>` : `<span class="sub">No ${cur} figure</span><div class="sub">${esc(m.noValueReason ?? "")}</div>`;
      return `<tr>
        <td>${m.url ? `<a href="${esc(m.url)}">${esc(m.title)}</a>` : esc(m.title)}<div class="sub">${esc(m.competitor)} · ${esc(m.reason)}</div></td>
        <td class="num">${money(m.beforeCents)} → <b>${money(m.afterCents)}</b><div class="sub"><span class="pill ${m.direction === "down" ? "bad" : "good"}">${m.direction === "down" ? "▼" : "▲"} ${money(Math.abs(m.changeCents))} · ${pct}</span></div></td>
        <td class="num value">${value}</td>
      </tr>`;
    })
    .join("");

  const gapRows = (list: PriceGapAlert[]) =>
    list
      .slice(0, 25)
      .map(
        (g) => `<tr>
        <td><a href="${esc(g.url)}">${esc(g.title)}</a><div class="sub">${g.rivalsCompared} ${g.rivalsCompared === 1 ? "rival" : "rivals"} in stock</div></td>
        <td class="num">${money(g.yourPriceCents)}</td>
        <td>${esc(g.rivalName)} <span class="num">${money(g.rivalPriceCents)}</span></td>
        <td class="num strong bad-t">+${money(g.gapCents)}</td>
        <td class="num"><span class="pill bad">+${g.gapPercent.toFixed(1)}%</span></td>
      </tr>`,
      )
      .join("");
  const gapTable = (rows: string, against: string) =>
    `<div class="scroll"><table class="wide"><thead><tr><th>Your product</th><th class="num">Your price</th><th>${against}</th><th class="num">Gap (${cur})</th><th class="num">Gap (%)</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const cheaperRows = gapRows(insights.gaps.cheaperRivals);
  const aboveRows = gapRows(insights.gaps.pricedAbove);

  const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const promoRows = insights.promoTracker
    .slice(0, 30)
    .map((p: TrackedPromo) => {
      const offer = [p.percentOff ? `${p.percentOff}% off` : "", p.code ? `code ${p.code}` : ""].filter(Boolean).join(" · ");
      const started = p.startedAt ? day(p.startedAt) : `<span class="sub">Before we started watching</span>`;
      const ended = p.running ? `<span class="pill bad">Running</span>` : p.endedAt ? day(p.endedAt) : `<span class="sub">Over, date not recorded</span>`;
      const length = p.days !== undefined ? `${p.days} ${p.days === 1 ? "day" : "days"}${p.running ? " so far" : ""}` : "—";
      return `<tr>
        <td><b>${esc(p.storeName)}</b><div>${esc(p.text)}</div>${offer ? `<div class="sub">${esc(offer)}</div>` : ""}</td>
        <td class="num">${started}</td>
        <td class="num">${ended}</td>
        <td class="num">${length}</td>
        <td><span class="sub">${esc(p.advice)}</span></td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(insights.merchant.name)} · Undercut weekly report</title>
<style>
${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <div><div class="brand">Undercut</div><h1>${esc(insights.merchant.name)}: week of ${esc(week)}</h1></div>
    <div class="meta">${options.sample ? `<span class="pill neutral">Sample data</span> ` : ""}Watching ${insights.competitors.length} competitors · Generated ${esc(generated)}</div>
  </header>

  <div class="tiles">${tiles}</div>

  <section id="brief">
    <h2>This week's brief</h2>
    <p class="explain">The biggest price moves your competitors made this week, most important first. A ${cur} figure is shown only where we can work it out from your data: it is the weekly sales a cheaper rival puts at risk, and needs the product paired and your weekly sales. Where we can't, you still see the move and why there is no figure.</p>
    ${
      moveRows
        ? `<div class="scroll"><table class="wide"><thead><tr><th>Product and why it matters</th><th class="num">Price move</th><th class="num">${cur} at stake</th></tr></thead><tbody>${moveRows}</tbody></table></div>`
        : `<p class="empty">No competitor changed a price this week.</p>`
    }
  </section>

  <section id="prices">
    <h2>Prices to change this week</h2>
    ${
      actions
        ? `<div class="scroll"><table class="wide"><thead><tr><th>Product</th><th class="num">Now</th><th class="num">Recommended</th><th class="num">Margin</th><th class="num">Margin / week</th></tr></thead><tbody>${actions}</tbody></table></div>`
        : `<p class="empty">No price changes recommended. Your prices sit where your rules want them.</p>`
    }
  </section>

  <section id="gaps">
    <h2>Price gap alerts</h2>
    <p class="explain">Products where you cost more than the competition, using only products you have paired and rivals that have them in stock. The gap is how much more you charge, in euros and as a percent of their price. A small gap is often fine if your brand, shipping or service is stronger; a large one is where shoppers are most likely to go elsewhere.</p>
    <h3>Priced well above the market</h3>
    <p class="sub">You are at least ${insights.gaps.abovePercent}% above the average price of every rival in stock. These are the first to review.</p>
    ${aboveRows ? gapTable(aboveRows, "Rival average") : `<p class="empty">None. No paired product is ${insights.gaps.abovePercent}% or more above the market average.</p>`}
    <h3>A rival is cheaper</h3>
    <p class="sub">At least one rival in stock sells it for less than you, but you are within ${insights.gaps.abovePercent}% of the market average.</p>
    ${cheaperRows ? gapTable(cheaperRows, "Cheapest rival") : `<p class="empty">None. No rival in stock is cheaper than you on a paired product.</p>`}
  </section>

  <div class="two">
    <section>
      <h2>Where you stand</h2>
      ${positionBar}
      ${indexes ? `<div class="scroll" style="margin-top:16px"><table><thead><tr><th>Competitor</th><th class="num">Price index</th><th></th></tr></thead><tbody>${indexes}</tbody></table></div>` : ""}
    </section>
    <section>
      <h2>Promotion forecast</h2>
      ${promos ? `<ul class="plain">${promos}</ul>` : `<p class="empty">Not enough promotion history yet. Forecasts appear once a competitor has run two campaigns.</p>`}
    </section>
  </div>

  <section id="promos">
    <h2>Promo tracker</h2>
    <p class="explain">Every sale, discount code and free-shipping offer we have seen on your competitors' sites in the last six months, with the day it started and ended. Dates are the first check that saw it start or stop, so they can be a day out. Use it to decide whether to match an offer or let it pass; most sales end within a week or two.</p>
    ${
      promoRows
        ? `<div class="scroll"><table class="wide"><thead><tr><th>Competitor and offer</th><th class="num">Started</th><th class="num">Ended</th><th class="num">Length</th><th>Match or skip?</th></tr></thead><tbody>${promoRows}</tbody></table></div>`
        : `<p class="empty">No competitor promotions seen yet. Offers appear here as soon as one shows on a competitor's homepage.</p>`
    }
  </section>

  <section>
    <h2>What changed</h2>
    ${changes ? `<ul class="changes">${changes}</ul>` : `<p class="empty">Nothing changed at your competitors this week.</p>`}
  </section>

  <section>
    <h2>Product scorecard</h2>
    ${
      rows
        ? `<div class="scroll"><table class="wide"><thead><tr><th>Your product</th><th class="num">Your price</th><th>Cheapest rival in stock</th><th class="num">Gap</th><th>Position</th><th class="num">Sales at risk / wk</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<p class="empty">Confirm product matches with <code>undercut matches</code> to fill this in.</p>`
    }
  </section>

  <footer>
    Sales at risk is an estimate: each 1% a cheaper rival undercuts you is assumed to put ${config.priceSensitivity}% of that product's weekly sales at risk, up to ${Math.round(config.maxShareAtRisk * 100)}%.
    Margin figures assume unit sales hold. Recommendations follow your pricing rules: ${esc(rulesSummary(config))}.
  </footer>
</div>
</body>
</html>
`;
}

function tile(label: string, value: string, note: string, tone: string): string {
  return `<div class="tile ${tone}"><span class="label">${esc(label)}</span><span class="value">${esc(value)}</span><span class="note">${esc(note)}</span></div>`;
}

function legend(cls: string, label: string, n: number): string {
  return n > 0 ? `<span><span class="k ${cls}"></span>${label} ${n}</span>` : "";
}

function seg(n: number, total: number, cls: string, label: string): string {
  return n > 0 ? `<span class="${cls}" style="width:${((n / total) * 100).toFixed(2)}%" title="${label}: ${n}"></span>` : "";
}

function chipClass(kind: string): string {
  if (kind === "price_drop" || kind === "promo_started" || kind === "new_product") return "bad";
  if (kind === "out_of_stock" || kind === "removed_product" || kind === "price_increase") return "good";
  return "muted";
}

function rulesSummary(config: Config): string {
  const p = config.pricing;
  const strategy =
    p.strategy === "beat" ? `${p.beatByPercent}% under the cheapest rival` : p.strategy === "match" ? "match the cheapest rival" : `${p.premiumPercent}% above the cheapest rival`;
  return `${strategy}, never below a ${p.minMarginPercent}% margin, at most a ${p.maxChangePercent}% change at a time`;
}

/** Shared by every Undercut report page. */
export const REPORT_CSS = `@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap");
:root {
  --bg: #f6f6fb; --surface: #fff; --fg: #1e2233; --muted: #646a80; --line: #e6e6f0;
  --accent: #5b63c9; --accent-bg: #ecebfb; --good: #2f7a5a; --good-bg: #e4f4ec; --bad: #a8455d; --bad-bg: #fbe7ec;
  --neutral: #8a6413; --neutral-bg: #fcf1dc; --muted-bg: #f1f1f8;
  --t1: #efe9fb; --t2: #e5f1fb; --t3: #e3f5ee; --t4: #fdeee6;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14151d; --surface: #1c1e29; --fg: #e9eaf2; --muted: #9da1b6; --line: #2b2e3d;
    --accent: #a3a9f2; --accent-bg: #2a2c47; --good: #8fd3b2; --good-bg: #1d3229; --bad: #eda2b3; --bad-bg: #3b2229;
    --neutral: #e5cd85; --neutral-bg: #352e18; --muted-bg: #232533;
    --t1: #2a2440; --t2: #1d2b3a; --t3: #1b3129; --t4: #36271f; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #14151d; --surface: #1c1e29; --fg: #e9eaf2; --muted: #9da1b6; --line: #2b2e3d;
  --accent: #a3a9f2; --accent-bg: #2a2c47; --good: #8fd3b2; --good-bg: #1d3229; --bad: #eda2b3; --bad-bg: #3b2229;
  --neutral: #e5cd85; --neutral-bg: #352e18; --muted-bg: #232533;
  --t1: #2a2440; --t2: #1d2b3a; --t3: #1b3129; --t4: #36271f; color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; display: flex; flex-direction: column; gap: 28px; }
header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: end; gap: 8px 24px; }
h1 { margin: 4px 0 0; font-size: 1.8rem; letter-spacing: -0.02em; line-height: 1.2; }
h2 { margin: 0 0 14px; font-size: 1.1rem; letter-spacing: -0.01em; }
.meta { color: var(--muted); font-size: 0.88rem; }
.brand { font-weight: 700; color: var(--accent); letter-spacing: 0.04em; text-transform: uppercase; font-size: 0.78rem; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.tile { background: var(--t1); border: 1px solid var(--line); border-radius: 14px; padding: 18px; display: flex; flex-direction: column; gap: 4px; }
.tile .label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.tile .value { font-size: 1.8rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.tile.bad .value { color: var(--bad); } .tile.good .value { color: var(--good); }
.tile .note { font-size: 0.85rem; color: var(--muted); }
.tile:nth-child(2) { background: var(--t2); } .tile:nth-child(3) { background: var(--t3); } .tile:nth-child(4) { background: var(--t4); }
section { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 22px; min-width: 0; box-shadow: 0 1px 2px rgba(30,34,51,.04), 0 6px 24px rgba(30,34,51,.05); }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
.bar { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--muted-bg); }
.bar span { display: block; height: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 10px; font-size: 0.85rem; color: var(--muted); align-items: center; }
.k { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; }
.good { background: var(--good-bg); color: var(--good); } .bad { background: var(--bad-bg); color: var(--bad); }
.neutral { background: var(--neutral-bg); color: var(--neutral); } .muted { background: var(--muted-bg); color: var(--muted); }
.bar .good, .k.good { background: var(--good); } .bar .bad, .k.bad { background: var(--bad); }
.bar .neutral, .k.neutral { background: var(--neutral); } .bar .muted, .k.muted { background: var(--muted); opacity: 0.5; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
th { text-align: left; font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--line); }
td { padding: 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
td.num, th.num { text-align: right; }
.strong { font-weight: 700; }
.good-t { color: var(--good); font-weight: 600; }
.bad-t { color: var(--bad); font-weight: 600; }
h3 { margin: 18px 0 4px; font-size: 0.98rem; }
.explain { margin: -6px 0 14px; color: var(--muted); font-size: 0.9rem; max-width: 70ch; }
td.value { min-width: 150px; white-space: normal; }
td.value .sub { max-width: 220px; margin-left: auto; }
.sub { color: var(--muted); font-size: 0.85rem; margin: 2px 0 0; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.78rem; font-weight: 600; white-space: nowrap; }
ul.changes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
ul.changes li { display: grid; grid-template-columns: 110px 1fr; gap: 12px; align-items: start; }
ul.changes p { margin: 0; }
.chip { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 4px 6px; border-radius: 6px; text-align: center; }
ul.plain { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
a { color: var(--accent); }
.empty { color: var(--muted); margin: 0; }
footer { color: var(--muted); font-size: 0.82rem; }
table.wide td:first-child { min-width: 240px; }
@media (max-width: 520px) { ul.changes li { grid-template-columns: 1fr; gap: 4px; } .chip { justify-self: start; } }
`;

import { formatCents } from "../money.js";
import type { Insights } from "../pipeline.js";
import type { PriceRecommendation } from "./pricing.js";
import type { TrackedPromo } from "./reports.js";

/** Shown wherever a total would need the client's own sales and we don't have them. */
export const CONNECT_SALES_NOTE = "Connect your sales to see the total";

export interface MoveImpact {
  /** What the move changes on each sale, signed: positive earns more per sale. */
  perUnitCents?: number;
  /** The per-sale effect in words, e.g. "+€2.00 on each sale". */
  perUnit: string;
  /** Weekly total. Only ever set from the client's own weekly sales, never from a rival's. */
  totalCents?: number;
  /** The total in words, e.g. "About +€84.00 a week". */
  total?: string;
  /** Why there is no total, when there isn't one. */
  note?: string;
}

export interface SuggestedMove {
  kind: "raise" | "cut" | "hold" | "promo";
  /** The move in plain words: "Raise Glow Serum to €24.99". */
  title: string;
  /** One line on why. */
  why: string;
  impact: MoveImpact;
  url?: string;
  /** Anchor on the details page that backs the card up. */
  detailsAnchor: string;
}

export interface ReportSummary {
  doingWell: string[];
  needsAttention: string[];
  moves: SuggestedMove[];
  /** How many moves there were before the cap, so the page can say "see all". */
  totalMoves: number;
}

/**
 * The rule for every money figure on the first page. A weekly total is shown
 * only when the client's own weekly sales for the product are known. Without
 * them the card gets the per-sale figure and a note asking to connect sales.
 * A rival's sales are never known, so nothing here ever rests on them.
 */
export function moveImpact(
  input: {
    perUnitCents?: number;
    perUnit: string;
    /** The client's own weekly unit sales for the product; undefined when not connected. */
    unitsPerWeek?: number;
    /** A total already worked out from the client's own data. Defaults to per sale × units. */
    totalCents?: number;
    totalLabel?: (cents: number) => string;
    /** Note for when sales are known but the total still can't be worked out. */
    missingTotalNote?: string;
  },
  money: (cents: number) => string,
): MoveImpact {
  const out: MoveImpact = { perUnitCents: input.perUnitCents, perUnit: input.perUnit };
  if (input.unitsPerWeek === undefined) {
    out.note = CONNECT_SALES_NOTE;
    return out;
  }
  const total = input.totalCents ?? (input.perUnitCents !== undefined ? Math.round(input.perUnitCents * input.unitsPerWeek) : undefined);
  if (total === undefined) {
    out.note = input.missingTotalNote ?? CONNECT_SALES_NOTE;
    return out;
  }
  out.totalCents = total;
  out.total = input.totalLabel ? input.totalLabel(total) : `About ${signed(total, money)} a week`;
  return out;
}

/** The first page of the report: what's going well, what isn't, and the moves to make. */
export function buildSummary(insights: Insights, options: { now?: Date; maxMoves?: number } = {}): ReportSummary {
  const money = (c: number) => formatCents(c, insights.currency);
  const maxMoves = options.maxMoves ?? 6;
  const positions = new Map(insights.scorecard.positions.map((p) => [p.product.externalId, p]));
  const units = (id: string) => positions.get(id)?.product.unitsPerWeek ?? insights.merchantProducts.find((p) => p.externalId === id)?.unitsPerWeek;

  const priced: SuggestedMove[] = insights.recommendations.map((r) => priceMove(r, positions.get(r.externalId)?.cheapestRival, units(r.externalId), money));
  const promos = insights.promoTracker.filter((p) => p.running).map((p) => promoMove(p));

  // Within each kind: a known total first, biggest first, then by what the move changes on each sale.
  const byImpact = (a: SuggestedMove, b: SuggestedMove) =>
    Number(a.impact.totalCents === undefined) - Number(b.impact.totalCents === undefined) ||
    Math.abs(b.impact.totalCents ?? 0) - Math.abs(a.impact.totalCents ?? 0) ||
    Math.abs(b.impact.perUnitCents ?? 0) - Math.abs(a.impact.perUnitCents ?? 0);
  const of = (kind: SuggestedMove["kind"]) => priced.filter((m) => m.kind === kind).sort(byImpact);
  // Defend first (cuts, then the two freshest rival promotions), then take the headroom, then the holds.
  const all = [...of("cut"), ...promos.slice(0, 2), ...of("raise"), ...of("hold"), ...promos.slice(2)];

  return { ...lists(insights, money), moves: all.slice(0, maxMoves), totalMoves: all.length };
}

function priceMove(r: PriceRecommendation, rival: { storeName: string; priceCents: number } | undefined, unitsPerWeek: number | undefined, money: (c: number) => string): SuggestedMove {
  const base = { url: r.url, detailsAnchor: "prices" };
  const rivalName = rival?.storeName ?? "The cheapest rival";
  if (r.action === "raise") {
    const per = r.recommendedCents - r.currentCents;
    return {
      ...base,
      kind: "raise",
      title: `Raise ${r.title} to ${money(r.recommendedCents)}`,
      why: rival ? `You're the cheapest. ${rival.storeName} charges ${money(rival.priceCents)}.` : "You're the cheapest, with room to spare.",
      impact: moveImpact({ perUnitCents: per, perUnit: `${signed(per, money)} on each sale`, unitsPerWeek, totalLabel: (t) => `About ${signed(t, money)} a week, if sales hold` }, money),
    };
  }
  if (r.action === "cut") {
    const per = r.recommendedCents - r.currentCents;
    return {
      ...base,
      kind: "cut",
      title: `Cut ${r.title} to ${money(r.recommendedCents)}`,
      why: rival ? `${rival.storeName} sells it for ${money(rival.priceCents)}, so shoppers are going there.` : "A rival is cheaper, so shoppers are going there.",
      impact: moveImpact(
        {
          perUnitCents: per,
          perUnit: `${money(Math.abs(per))} less on each sale, to win sales back`,
          unitsPerWeek,
          // The cut's total needs your costs as well as your sales; it compares the cut with doing nothing.
          totalCents: r.weeklyMarginImpactCents,
          totalLabel: (t) => `About ${signed(t, money)} a week compared with doing nothing`,
          missingTotalNote: "Add your unit costs to see the total",
        },
        money,
      ),
    };
  }
  const considered = r.consideredCents ?? r.currentCents;
  const per = r.currentCents - considered;
  return {
    ...base,
    kind: "hold",
    title: `Keep ${r.title} at ${money(r.currentCents)}`,
    why: `${rivalName} is cheaper, but matching would cost more margin than the sales it wins back.`,
    impact: moveImpact(
      {
        perUnitCents: per,
        perUnit: `Keeps ${money(per)} more on each sale than matching`,
        unitsPerWeek,
        totalCents: r.weeklyMarginImpactCents !== undefined ? -r.weeklyMarginImpactCents : undefined,
        totalLabel: (t) => `Saves about ${money(t)} a week compared with matching`,
        missingTotalNote: "Add your unit costs to see the total",
      },
      money,
    ),
  };
}

function promoMove(p: TrackedPromo): SuggestedMove {
  const offer = p.percentOff ? `${p.percentOff}% off` : p.kind === "free_shipping" ? "free shipping" : "a sale";
  return {
    kind: "promo",
    title: `Decide whether to answer ${p.storeName}'s ${offer}`,
    why: p.advice || `"${p.text}" is running now.`,
    // There's no honest total: it depends on which products you'd discount.
    impact: {
      perUnit: p.percentOff ? `Matching costs ${p.percentOff}% of the price on each sale` : "The cost depends on what you offer back",
      note: "No total: it depends on which products you'd put on offer",
    },
    detailsAnchor: "promos",
  };
}

function lists(insights: Insights, money: (c: number) => string): { doingWell: string[]; needsAttention: string[] } {
  const t = insights.scorecard.totals;
  const well: string[] = [];
  const bad: string[] = [];
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

  if (t.cheapest > 0) well.push(`You're the cheapest on ${n(t.cheapest, "product")} you share with rivals.`);
  if (t.matched > 0) well.push(`You're level with the cheapest rival on ${n(t.matched, "product")}.`);
  if (t.noRivalInStock > 0) well.push(`Rivals are sold out on ${n(t.noRivalInStock, "product")} you have in stock.`);
  for (const ix of insights.scorecard.indexes) {
    const diff = Math.round((ix.index - 100) * 10) / 10;
    if (diff < -0.5) well.push(`Overall you're ${-diff}% cheaper than ${ix.storeName}.`);
    else if (diff > 0.5) bad.push(`Overall you're ${diff}% more expensive than ${ix.storeName}.`);
  }
  const raises = insights.recommendations.filter((r) => r.action === "raise");
  if (raises.length > 0) well.push(`You have room to raise ${n(raises.length, "price")} and still be the cheapest.`);

  if (t.undercut > 0) {
    bad.push(
      `A rival is cheaper on ${n(t.undercut, "product")}` + (t.revenueAtRiskCents > 0 ? `, putting about ${money(t.revenueAtRiskCents)} of your weekly sales at risk.` : "."),
    );
  }
  if (insights.gaps.pricedAbove.length > 0) bad.push(`${n(insights.gaps.pricedAbove.length, "product is", "products are")} priced well above the market.`);
  const cuts = insights.priceMoves.filter((m) => m.direction === "down").length;
  if (cuts > 0) bad.push(`Rivals cut ${n(cuts, "price")} this week.`);
  const running = insights.promoTracker.filter((p) => p.running);
  if (running.length > 0) bad.push(`${names(running.map((p) => p.storeName))} ${running.length === 1 ? "is" : "are"} running a promotion now.`);
  if (t.undercutWithoutSalesData > 0) bad.push(`${n(t.undercutWithoutSalesData, "undercut product has", "undercut products have")} no sales figures yet. ${CONNECT_SALES_NOTE}.`);
  if (t.matchedProducts === 0) bad.push("No products are paired with a rival yet, so we can't compare prices.");

  if (well.length === 0) well.push("Nothing stands out yet. This fills in as we pair more products.");
  if (bad.length === 0) bad.push("Nothing needs your attention this week.");
  return { doingWell: well.slice(0, 5), needsAttention: bad.slice(0, 5) };
}

function names(list: string[]): string {
  const u = [...new Set(list)];
  return u.length > 1 ? `${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}` : (u[0] ?? "");
}

function signed(cents: number, money: (c: number) => string): string {
  return `${cents >= 0 ? "+" : "−"}${money(Math.abs(cents))}`;
}

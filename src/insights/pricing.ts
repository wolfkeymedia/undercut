import type { PricingConfig } from "../config.js";
import { formatCents } from "../money.js";
import type { ProductPosition } from "./position.js";

export interface PriceRecommendation {
  externalId: string;
  title: string;
  url: string;
  /** "hold" means a cut was considered and would lose more margin than it protects. */
  action: "raise" | "cut" | "hold";
  currentCents: number;
  /** For a hold, the current price. The rejected cut is in consideredCents. */
  recommendedCents: number;
  consideredCents?: number;
  /** Plain-English reason, safe to show the merchant as is. */
  reason: string;
  /** Margin over unit cost at the recommended price, when cost is known. */
  marginPercent?: number;
  /**
   * Expected weekly gross-margin effect of the action, when sales and cost are known.
   * Raise: the extra margin if unit sales hold. Cut: margin after the cut minus the
   * margin you would keep by doing nothing while the rival takes its share.
   * Hold: the margin the rejected cut would have lost (negative).
   */
  weeklyMarginImpactCents?: number;
  /** Set when a rule stopped the price from reaching the strategy's target. */
  limitedBy?: "margin_floor" | "max_change";
}

/**
 * Applies the merchant's pricing rules to each matched product and returns the
 * prices worth changing. Never goes below the margin floor, never moves more
 * than the step limit, holds prices while the cheapest rival is out of stock,
 * and holds rather than cuts when the cut gives away more margin than the
 * estimated sales at risk are worth. Prices end in .99 when rounding is on.
 */
export function recommendPrices(positions: ProductPosition[], rules: PricingConfig, currency = "USD"): PriceRecommendation[] {
  const money = (c: number) => formatCents(c, currency);
  const out: PriceRecommendation[] = [];

  for (const pos of positions) {
    const p = pos.product;
    const rival = pos.cheapestRival;
    if (!rival) continue;

    const target =
      rules.strategy === "match"
        ? rival.priceCents
        : rules.strategy === "premium"
          ? rival.priceCents * (1 + rules.premiumPercent / 100)
          : rival.priceCents * (1 - rules.beatByPercent / 100);

    const floor = p.costCents !== undefined ? Math.ceil(p.costCents / (1 - rules.minMarginPercent / 100)) : 0;
    const maxStep = (p.priceCents * rules.maxChangePercent) / 100;
    let price = Math.min(Math.max(target, p.priceCents - maxStep), p.priceCents + maxStep);
    let limitedBy: PriceRecommendation["limitedBy"] = price !== target ? "max_change" : undefined;
    if (price < floor) {
      price = floor;
      limitedBy = "margin_floor";
    }
    price = roundPrice(price, rules.rounding, floor, p.priceCents);

    // Only cut when a rival is actually cheaper; being level or already under is not a reason to give up margin.
    if (price < p.priceCents && pos.position !== "undercut") continue;
    const changePct = ((price - p.priceCents) / p.priceCents) * 100;
    if (Math.abs(changePct) < rules.minChangePercent) continue;
    // A floor above today's price is a pricing problem, not a competitive move; leave it to the merchant.
    if (limitedBy === "margin_floor" && price > p.priceCents && pos.position === "undercut") continue;

    const known = p.unitsPerWeek !== undefined && p.costCents !== undefined;
    const marginAt = (cents: number) => (known ? p.unitsPerWeek! * (cents - p.costCents!) : 0);
    const marginPercent = (cents: number) => (p.costCents !== undefined ? Math.round(((cents - p.costCents) / cents) * 1000) / 10 : undefined);
    const base = { externalId: p.externalId, title: p.title, url: p.url, currentCents: p.priceCents, limitedBy };

    if (price > p.priceCents) {
      out.push({
        ...base,
        action: "raise",
        recommendedCents: price,
        marginPercent: marginPercent(price),
        weeklyMarginImpactCents: p.unitsPerWeek !== undefined ? Math.round((price - p.priceCents) * p.unitsPerWeek) : undefined,
        reason:
          `You are the cheapest. ${rival.storeName} charges ${money(rival.priceCents)}, so ${money(price)} keeps you ${rules.strategy === "premium" ? "within your premium band" : "at or below them"}.` +
          (limitedBy === "max_change" ? ` Capped at a ${rules.maxChangePercent}% step; review again next week.` : ""),
      });
      continue;
    }

    // A cut keeps the sales at risk but earns less on every unit. Compare it with doing nothing.
    const impact = known && pos.marginAtRiskCents !== undefined ? Math.round(marginAt(price) - (marginAt(p.priceCents) - pos.marginAtRiskCents)) : undefined;
    if (impact !== undefined && impact <= 0) {
      const giveaway = Math.round(marginAt(p.priceCents) - marginAt(price));
      out.push({
        ...base,
        action: "hold",
        recommendedCents: p.priceCents,
        consideredCents: price,
        marginPercent: marginPercent(p.priceCents),
        weeklyMarginImpactCents: impact,
        reason: `${rival.storeName} is at ${money(rival.priceCents)}, but cutting to ${money(price)} would give up ${money(giveaway)} a week in margin to protect about ${money(pos.marginAtRiskCents!)}. Hold your price and compete on value, bundles or shipping.`,
      });
      continue;
    }

    let reason =
      limitedBy === "margin_floor"
        ? `${rival.storeName} is at ${money(rival.priceCents)}. ${money(price)} is as low as you can go and keep a ${rules.minMarginPercent}% margin.`
        : `${rival.storeName} is at ${money(rival.priceCents)}. ${money(price)} puts you ${rules.strategy === "match" ? "level with" : rules.strategy === "premium" ? "back inside your premium band over" : "just under"} them.`;
    if (limitedBy === "max_change") reason += ` Capped at a ${rules.maxChangePercent}% step; review again next week.`;
    if (impact !== undefined) reason += ` Worth about ${money(impact)} a week more than doing nothing.`;
    out.push({ ...base, action: "cut", recommendedCents: price, marginPercent: marginPercent(price), weeklyMarginImpactCents: impact, reason });
  }

  // Changes before holds, then biggest money first; unknown impact last.
  return out.sort(
    (a, b) =>
      Number(a.action === "hold") - Number(b.action === "hold") ||
      Math.abs(b.weeklyMarginImpactCents ?? 0) - Math.abs(a.weeklyMarginImpactCents ?? 0),
  );
}

/**
 * Rounds down to the nearest price ending in .99, so a rounded price never
 * overshoots the target. If that would cross the margin floor, rounds up to
 * the first .99 price at or above the floor instead.
 */
export function roundPrice(cents: number, rounding: PricingConfig["rounding"], floor = 0, currentCents?: number): number {
  const whole = Math.max(Math.round(cents), floor);
  if (rounding === "none") return whole;
  // "match" keeps the store's own price ending, e.g. .95 or .00, taken from the current price.
  const ending = rounding === "match" ? (currentCents !== undefined ? currentCents % 100 : 99) : Number(rounding);
  const down = Math.floor((whole - ending) / 100) * 100 + ending;
  if (down >= floor && down > 0) return down;
  return Math.ceil((floor - ending) / 100) * 100 + ending;
}

/** Recommendations as CSV, one row per product, for review or bulk editing. */
export function recommendationsCsv(recs: PriceRecommendation[]): string {
  const handle = (url: string) => url.match(/\/products\/([^/?#]+)/)?.[1] ?? "";
  const cell = (v: string | number | undefined) => {
    const s = v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [["handle", "title", "url", "action", "current_price", "recommended_price", "margin_percent", "weekly_margin_impact", "reason"].join(",")];
  for (const r of recs) {
    lines.push(
      [
        handle(r.url),
        r.title,
        r.url,
        r.action,
        (r.currentCents / 100).toFixed(2),
        (r.recommendedCents / 100).toFixed(2),
        r.marginPercent,
        r.weeklyMarginImpactCents !== undefined ? (r.weeklyMarginImpactCents / 100).toFixed(2) : undefined,
        r.reason,
      ]
        .map(cell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

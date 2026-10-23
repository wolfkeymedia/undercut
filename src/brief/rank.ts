import { formatCents, percentChange } from "../money.js";
import type { ChangeEvent, ProductMatch, ProductSnapshot, Store } from "../types.js";

export interface BriefItem {
  event: ChangeEvent;
  competitor: string;
  /** The merchant's own product this event concerns, when a confirmed match exists. */
  yourProduct?: { title: string; priceCents: number; costCents?: number };
  /** Competitor price minus your price, after the change. Negative means they are cheaper. */
  gapCents?: number;
  score: number;
  /** A concrete next step computed from the numbers. The brief writer may reword it but not change it. */
  suggestion?: string;
  /** Estimated weekly sales at risk when a rival undercuts a product you sell. Needs your weekly units. */
  revenueAtRiskCents?: number;
}

export interface RankInput {
  events: ChangeEvent[];
  stores: Store[];
  matches: ProductMatch[];
  merchantProducts: ProductSnapshot[];
  /** Below this margin we never suggest matching a competitor's price. */
  minMarginPercent?: number;
  currency?: string;
  /** See Config.priceSensitivity and Config.maxShareAtRisk. */
  priceSensitivity?: number;
  maxShareAtRisk?: number;
}

/**
 * Turns raw change events into a ranked list for the brief. Collapses several
 * moves on one product into one net change, then scores each item by how much
 * it is likely to affect the merchant's sales.
 */
export function rankEvents(input: RankInput): BriefItem[] {
  const minMargin = input.minMarginPercent ?? 25;
  const currency = input.currency ?? "USD";
  const money = (c: number) => formatCents(c, currency);
  const storeName = new Map(input.stores.map((s) => [s.id, s.name]));
  const mine = new Map(input.merchantProducts.map((p) => [p.externalId, p]));
  const confirmed = new Map<string, string>();
  for (const m of input.matches) {
    if (m.status === "confirmed") confirmed.set(`${m.competitorStoreId}|${m.competitorExternalId}`, m.merchantExternalId);
  }

  const items: BriefItem[] = [];
  for (const event of collapse(input.events)) {
    const competitor = storeName.get(event.storeId) ?? event.storeId;
    const yoursId = event.externalId ? confirmed.get(`${event.storeId}|${event.externalId}`) : undefined;
    const yours = yoursId ? mine.get(yoursId) : undefined;
    const item: BriefItem = { event, competitor, score: 0 };
    if (yours) {
      item.yourProduct = { title: yours.title, priceCents: yours.priceCents, costCents: yours.costCents };
      if (event.afterCents !== undefined) item.gapCents = event.afterCents - yours.priceCents;
    }

    switch (event.kind) {
      case "price_drop":
      case "price_increase": {
        const pct = Math.abs(percentChange(event.beforeCents!, event.afterCents!));
        if (!yours) {
          item.score = 5 + pct / 4;
          break;
        }
        item.score = 40 + pct;
        const wasCheaper = event.beforeCents! < yours.priceCents;
        const nowCheaper = event.afterCents! < yours.priceCents;
        if (nowCheaper && !wasCheaper) item.score += 30;
        if (nowCheaper && yours.unitsPerWeek !== undefined) {
          const undercutPct = ((yours.priceCents - event.afterCents!) / yours.priceCents) * 100;
          const share = Math.min(input.maxShareAtRisk ?? 0.6, (undercutPct * (input.priceSensitivity ?? 2)) / 100);
          item.revenueAtRiskCents = Math.round(yours.unitsPerWeek * share * yours.priceCents);
          // One extra point per $25 a week at stake, so big sellers rise to the top.
          item.score += Math.min(40, item.revenueAtRiskCents / 2500);
        }
        if (nowCheaper && item.revenueAtRiskCents !== undefined && yours.costCents !== undefined) {
          // Matching earns less on every unit; only worth it if that beats losing the sales at risk.
          const units = yours.unitsPerWeek!;
          const unitMargin = yours.priceCents - yours.costCents;
          const marginAtRisk = (item.revenueAtRiskCents / yours.priceCents) * unitMargin;
          const giveaway = units * (yours.priceCents - event.afterCents!);
          if (giveaway >= marginAtRisk) {
            item.suggestion = `Matching at ${money(event.afterCents!)} would give up ${money(Math.round(giveaway))} a week in margin to protect about ${money(Math.round(marginAtRisk))}. Hold your price and compete on value, bundles or shipping.`;
          }
        }
        if (nowCheaper && !item.suggestion) {
          item.suggestion = matchSuggestion(event.afterCents!, yours, minMargin, money);
        } else if (event.kind === "price_increase") {
          item.suggestion = `You are now ${money(item.gapCents!)} cheaper on ${yours.title}. Say so in ads and on the product page.`;
        }
        break;
      }
      case "out_of_stock":
        item.score = yours ? 60 : 8;
        if (yours) item.suggestion = `They can't sell this right now. Feature ${yours.title} on your homepage and in ads until they restock.`;
        break;
      case "back_in_stock":
        item.score = yours ? 25 : 3;
        break;
      case "promo_started": {
        const pct = Number(event.promoKey?.match(/^percent_off:(\d+)/)?.[1] ?? 0);
        item.score = event.promoKey?.startsWith("percent_off") ? 30 + pct : event.promoKey?.startsWith("discount_code") ? 30 : 20;
        item.suggestion = "Watch your conversion rate while it runs before reacting. Most promos end within a week.";
        break;
      }
      case "promo_ended":
        item.score = 6;
        break;
      case "new_product":
        item.score = 10;
        item.suggestion = "Check whether you carry an equivalent product.";
        break;
      case "removed_product":
        item.score = yours ? 35 : 4;
        if (yours) item.suggestion = `They dropped their version of ${yours.title}. Their customers may come looking for it.`;
        break;
    }
    items.push(item);
  }
  return items.sort((a, b) => b.score - a.score);
}

function matchSuggestion(
  theirPrice: number,
  yours: ProductSnapshot,
  minMargin: number,
  money: (c: number) => string,
): string {
  if (yours.costCents === undefined) {
    return `They are ${money(yours.priceCents - theirPrice)} cheaper. Add your unit cost to see whether matching is profitable.`;
  }
  const margin = ((theirPrice - yours.costCents) / theirPrice) * 100;
  if (margin >= minMargin) {
    return `Matching at ${money(theirPrice)} keeps a ${margin.toFixed(0)}% margin.`;
  }
  return `Matching at ${money(theirPrice)} would cut your margin to ${margin.toFixed(0)}%. Hold your price and compete on value, bundles or shipping instead.`;
}

/**
 * Merges events on the same product and kind family into one net change, so a
 * price that dipped and recovered within the week is not reported twice.
 */
export function collapse(events: ChangeEvent[]): ChangeEvent[] {
  const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const priceByProduct = new Map<string, ChangeEvent>();
  const stockByProduct = new Map<string, ChangeEvent>();
  const promoByKey = new Map<string, ChangeEvent>();
  const rest: ChangeEvent[] = [];

  for (const e of sorted) {
    const key = `${e.storeId}|${e.externalId ?? e.promoKey}`;
    if (e.kind === "price_drop" || e.kind === "price_increase") {
      const first = priceByProduct.get(key);
      priceByProduct.set(key, first ? { ...e, beforeCents: first.beforeCents } : e);
    } else if (e.kind === "out_of_stock" || e.kind === "back_in_stock") {
      const first = stockByProduct.get(key);
      // Out then back in (or the reverse) within the window cancels out.
      if (first && first.kind !== e.kind) stockByProduct.delete(key);
      else stockByProduct.set(key, e);
    } else if (e.kind === "promo_started" || e.kind === "promo_ended") {
      const first = promoByKey.get(key);
      if (first && first.kind !== e.kind) {
        // Started and ended inside the window: keep it as a short promo.
        promoByKey.set(key, { ...first, detail: [first.detail, "ended within the week"].filter(Boolean).join("; ") });
      } else {
        promoByKey.set(key, e);
      }
    } else {
      rest.push(e);
    }
  }

  const netPrices = [...priceByProduct.values()]
    .filter((e) => e.beforeCents !== e.afterCents)
    .map((e): ChangeEvent => ({ ...e, kind: e.afterCents! < e.beforeCents! ? "price_drop" : "price_increase" }));
  return [...netPrices, ...stockByProduct.values(), ...mergeSameBanner([...promoByKey.values()]), ...rest];
}

/**
 * One banner often yields several promotions ("20% off with code BREW20" is a
 * percent off and a code). Report it once, keeping the code as detail.
 */
function mergeSameBanner(events: ChangeEvent[]): ChangeEvent[] {
  const byBanner = new Map<string, ChangeEvent>();
  for (const e of events) {
    const key = `${e.storeId}|${e.kind}|${e.title}`;
    const first = byBanner.get(key);
    if (!first) {
      byBanner.set(key, e);
      continue;
    }
    // Prefer the percent-off key, which carries the discount depth used for ranking.
    const keep = e.promoKey?.startsWith("percent_off") ? e : first;
    const details = [...new Set([first.detail, e.detail].filter(Boolean))];
    byBanner.set(key, { ...keep, detail: details.length ? details.join("; ") : undefined });
  }
  return [...byBanner.values()];
}

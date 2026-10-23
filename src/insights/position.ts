import type { Config } from "../config.js";
import type { ProductMatch, ProductSnapshot, Store } from "../types.js";

export interface RivalPrice {
  storeId: string;
  storeName: string;
  title: string;
  url: string;
  priceCents: number;
  available: boolean;
  /** Their price relative to yours, in percent. Negative means they are cheaper. */
  gapPercent: number;
}

export type Position = "cheapest" | "matched" | "undercut" | "no_rival_in_stock";

export interface ProductPosition {
  product: ProductSnapshot;
  rivals: RivalPrice[];
  /** Cheapest rival that has the product in stock. */
  cheapestRival?: RivalPrice;
  position: Position;
  /** Estimated weekly revenue you could lose to the cheapest rival. Needs unitsPerWeek. */
  revenueAtRiskCents?: number;
  /** Same, as gross margin. Needs unitsPerWeek and costCents. */
  marginAtRiskCents?: number;
}

export interface PriceIndex {
  storeId: string;
  storeName: string;
  /** 100 means level. 104 means you are 4% more expensive on the products you both sell. */
  index: number;
  comparedProducts: number;
}

export interface Scorecard {
  positions: ProductPosition[];
  indexes: PriceIndex[];
  totals: {
    matchedProducts: number;
    cheapest: number;
    matched: number;
    undercut: number;
    noRivalInStock: number;
    revenueAtRiskCents: number;
    marginAtRiskCents: number;
    /** Products undercut but missing sales data, so their risk is not counted in the totals. */
    undercutWithoutSalesData: number;
  };
}

/** Prices within this percent of each other count as matched. */
const MATCHED_BAND_PERCENT = 0.5;

/**
 * Compares every one of your products that has a confirmed competitor match:
 * where you stand on price, how each competitor's prices compare overall, and
 * how much weekly revenue cheaper rivals put at risk.
 */
export function buildScorecard(input: {
  merchantProducts: ProductSnapshot[];
  competitorProducts: Map<string, ProductSnapshot[]>;
  stores: Store[];
  matches: ProductMatch[];
  config: Pick<Config, "priceSensitivity" | "maxShareAtRisk">;
}): Scorecard {
  const storeName = new Map(input.stores.map((s) => [s.id, s.name]));
  const theirs = new Map<string, ProductSnapshot>();
  for (const [storeId, products] of input.competitorProducts) {
    for (const p of products) theirs.set(`${storeId}|${p.externalId}`, p);
  }
  const rivalsByProduct = new Map<string, RivalPrice[]>();
  const mine = new Map(input.merchantProducts.map((p) => [p.externalId, p]));

  for (const m of input.matches) {
    if (m.status !== "confirmed") continue;
    const yours = mine.get(m.merchantExternalId);
    const rival = theirs.get(`${m.competitorStoreId}|${m.competitorExternalId}`);
    if (!yours || !rival) continue;
    const list = rivalsByProduct.get(yours.externalId) ?? [];
    list.push({
      storeId: m.competitorStoreId,
      storeName: storeName.get(m.competitorStoreId) ?? m.competitorStoreId,
      title: rival.title,
      url: rival.url,
      priceCents: rival.priceCents,
      available: rival.available,
      gapPercent: ((rival.priceCents - yours.priceCents) / yours.priceCents) * 100,
    });
    rivalsByProduct.set(yours.externalId, list);
  }

  const positions: ProductPosition[] = [];
  for (const [id, rivals] of rivalsByProduct) {
    const product = mine.get(id)!;
    rivals.sort((a, b) => a.priceCents - b.priceCents);
    const cheapestRival = rivals.find((r) => r.available);
    const pos: ProductPosition = { product, rivals, cheapestRival, position: "no_rival_in_stock" };
    if (cheapestRival) {
      if (Math.abs(cheapestRival.gapPercent) <= MATCHED_BAND_PERCENT) pos.position = "matched";
      else if (cheapestRival.gapPercent < 0) pos.position = "undercut";
      else pos.position = "cheapest";
    }
    if (pos.position === "undercut" && product.unitsPerWeek !== undefined) {
      const share = Math.min(input.config.maxShareAtRisk, (-cheapestRival!.gapPercent * input.config.priceSensitivity) / 100);
      const unitsAtRisk = product.unitsPerWeek * share;
      pos.revenueAtRiskCents = Math.round(unitsAtRisk * product.priceCents);
      if (product.costCents !== undefined) {
        pos.marginAtRiskCents = Math.round(unitsAtRisk * (product.priceCents - product.costCents));
      }
    }
    positions.push(pos);
  }
  positions.sort((a, b) => (b.revenueAtRiskCents ?? 0) - (a.revenueAtRiskCents ?? 0) || order(a.position) - order(b.position));

  const indexes: PriceIndex[] = [];
  const byStore = new Map<string, number[]>();
  for (const pos of positions) {
    for (const r of pos.rivals) {
      if (!r.available) continue;
      const ratios = byStore.get(r.storeId) ?? [];
      ratios.push(pos.product.priceCents / r.priceCents);
      byStore.set(r.storeId, ratios);
    }
  }
  for (const [storeId, ratios] of byStore) {
    // Geometric mean, so one product at 2x and one at 0.5x average out to level.
    const geo = Math.exp(ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length);
    indexes.push({ storeId, storeName: storeName.get(storeId) ?? storeId, index: Math.round(geo * 1000) / 10, comparedProducts: ratios.length });
  }
  indexes.sort((a, b) => b.index - a.index);

  const count = (p: Position) => positions.filter((x) => x.position === p).length;
  return {
    positions,
    indexes,
    totals: {
      matchedProducts: positions.length,
      cheapest: count("cheapest"),
      matched: count("matched"),
      undercut: count("undercut"),
      noRivalInStock: count("no_rival_in_stock"),
      revenueAtRiskCents: positions.reduce((s, p) => s + (p.revenueAtRiskCents ?? 0), 0),
      marginAtRiskCents: positions.reduce((s, p) => s + (p.marginAtRiskCents ?? 0), 0),
      undercutWithoutSalesData: positions.filter((p) => p.position === "undercut" && p.revenueAtRiskCents === undefined).length,
    },
  };
}

function order(p: Position): number {
  return { undercut: 0, matched: 1, cheapest: 2, no_rival_in_stock: 3 }[p];
}

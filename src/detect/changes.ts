import type { ChangeEvent, StoreObservation } from "../types.js";

export interface DetectOptions {
  /** Ignore price moves smaller than this, in percent. Filters rounding noise and currency jitter. */
  minPricePercent?: number;
}

/**
 * Compares two observations of the same store and lists what changed. The
 * first observation of a store is a baseline and produces no events.
 */
export function detectChanges(
  previous: StoreObservation | null,
  current: StoreObservation,
  options: DetectOptions = {},
): ChangeEvent[] {
  if (!previous) return [];
  const minPct = options.minPricePercent ?? 0.5;
  const events: ChangeEvent[] = [];
  const at = current.observedAt;
  const base = { storeId: current.storeId, occurredAt: at };

  const before = new Map(previous.products.map((p) => [p.externalId, p]));
  const after = new Map(current.products.map((p) => [p.externalId, p]));

  for (const [id, now] of after) {
    const was = before.get(id);
    const product = { ...base, externalId: id, title: now.title, url: now.url };
    if (!was) {
      events.push({ ...product, kind: "new_product", afterCents: now.priceCents });
      continue;
    }
    if (was.priceCents !== now.priceCents) {
      const pct = (Math.abs(now.priceCents - was.priceCents) / was.priceCents) * 100;
      if (pct >= minPct) {
        events.push({
          ...product,
          kind: now.priceCents < was.priceCents ? "price_drop" : "price_increase",
          beforeCents: was.priceCents,
          afterCents: now.priceCents,
        });
      }
    }
    if (was.available && !now.available) events.push({ ...product, kind: "out_of_stock", afterCents: now.priceCents });
    if (!was.available && now.available) events.push({ ...product, kind: "back_in_stock", afterCents: now.priceCents });
  }

  // Only a full catalog feed can prove a product is gone; page-by-page
  // collection may simply not have reached it this run.
  if (previous.source === "shopify_feed" && current.source === "shopify_feed") {
    for (const [id, was] of before) {
      if (!after.has(id)) {
        events.push({ ...base, kind: "removed_product", externalId: id, title: was.title, url: was.url, beforeCents: was.priceCents });
      }
    }
  }

  const promosBefore = new Map(previous.promotions.map((p) => [p.key, p]));
  const promosAfter = new Map(current.promotions.map((p) => [p.key, p]));
  for (const [key, promo] of promosAfter) {
    if (!promosBefore.has(key)) events.push({ ...base, kind: "promo_started", promoKey: key, title: promo.text, detail: promo.code });
  }
  for (const [key, promo] of promosBefore) {
    if (!promosAfter.has(key)) events.push({ ...base, kind: "promo_ended", promoKey: key, title: promo.text, detail: promo.code });
  }

  return events;
}

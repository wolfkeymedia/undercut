import { describe, expect, it } from "vitest";
import { detectChanges } from "../src/detect/changes.js";
import type { ProductSnapshot, StoreObservation } from "../src/types.js";

const p = (id: string, priceCents: number, available = true): ProductSnapshot => ({
  externalId: id,
  title: `Product ${id}`,
  url: `https://x.example/products/${id}`,
  priceCents,
  available,
});

const obs = (products: ProductSnapshot[], promoKeys: string[] = [], source: StoreObservation["source"] = "shopify_feed"): StoreObservation => ({
  storeId: "x",
  observedAt: new Date("2026-10-20T08:00:00Z"),
  products,
  promotions: promoKeys.map((key) => ({ key, kind: "percent_off", text: key })),
  source,
});

describe("detectChanges", () => {
  it("treats the first observation as a baseline", () => {
    expect(detectChanges(null, obs([p("a", 1000)]))).toEqual([]);
  });

  it("reports price moves, stock changes, launches and removals", () => {
    const before = obs([p("a", 3800), p("b", 1000), p("c", 500, false), p("gone", 700)], ["percent_off:10"]);
    const after = obs([p("a", 3250), p("b", 1000, false), p("c", 500), p("new", 2000)], ["percent_off:20"]);
    const kinds = detectChanges(before, after).map((e) => `${e.kind}:${e.externalId ?? e.promoKey}`);
    expect(kinds.sort()).toEqual(
      [
        "price_drop:a",
        "out_of_stock:b",
        "back_in_stock:c",
        "new_product:new",
        "removed_product:gone",
        "promo_started:percent_off:20",
        "promo_ended:percent_off:10",
      ].sort(),
    );
  });

  it("ignores tiny price jitter", () => {
    expect(detectChanges(obs([p("a", 100000)]), obs([p("a", 100010)]))).toEqual([]);
  });

  it("does not claim removals when products were read page by page", () => {
    const events = detectChanges(obs([p("a", 1), p("b", 1)], [], "structured_data"), obs([p("a", 1)], [], "structured_data"));
    expect(events).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { buildMarket, categorize, isComparable } from "../src/insights/market.js";
import { renderMarketReport } from "../src/report/market.js";
import type { ProductSnapshot, Store } from "../src/types.js";

const ct: Store = { id: "ct", name: "Charlotte Tilbury", url: "https://ct.example/ie", kind: "competitor" };
const sba: Store = { id: "sba", name: "Sculpted by Aimee", url: "https://sba.example", kind: "competitor" };
const p = (id: string, title: string, euros: number, was?: number): ProductSnapshot => ({
  externalId: id,
  title,
  url: `https://x.example/${id}`,
  currency: "EUR",
  priceCents: euros * 100,
  compareAtCents: was ? was * 100 : undefined,
  available: true,
});

describe("market view", () => {
  it("sorts products into categories, kits first", () => {
    expect(categorize({ title: "Contour Kit" })).toBe("Kits & sets");
    expect(categorize({ title: "Pillow Talk Lip Cheat" })).toBe("Lip liner");
    expect(categorize({ title: "Airbrush Flawless Foundation" })).toBe("Foundation");
    expect(categorize({ title: "Gift Card", productType: "Gift Cards" })).toBe("Gift Cards");
    expect(categorize({ title: "Airbrush Brightening Flawless Finish", productType: "Powder" })).toBe("Powder");
    expect(categorize({ title: "Mini Lash Lift Mascara" })).toBe("Minis");
    expect(categorize({ title: "The Everyday Glow Edit" })).toBe("Kits & sets");
    expect(categorize({ title: "Airbrush Flawless Foundation – Tan-Deep" })).toBe("Foundation");
    expect(categorize({ title: "Dripping Gold Tan Mousse" })).toBe("Tanning");
    expect(categorize({ title: "Angle Duo Brush" })).toBe("Brushes & tools");
    expect(categorize({ title: "Blur + Lock Duo" })).toBe("Kits & sets");
    expect(categorize({ title: "Magic Cream – Travel" })).toBe("Minis");
    expect(categorize({ title: "Sculpted Academy Masterclass" })).not.toBe("Contour");
    expect(isComparable({ title: "Sculpted Academy Masterclass" })).toBe(false);
    expect(isComparable({ title: "eGift Card" })).toBe(false);
  });

  it("summarises each brand, compares categories and lists the biggest offers", () => {
    const market = buildMarket({
      stores: [ct, sba],
      products: new Map([
        ["ct", [p("1", "Airbrush Flawless Foundation", 44), p("2", "Hollywood Contour Wand", 38), p("3", "Glow Kit", 81, 90)]],
        ["sba", [p("a", "Second Skin Foundation", 32), p("b", "Cream Contour Stick", 25), p("c", "Pro Base Kit", 60, 80)]],
      ]),
      promotions: new Map([["sba", [{ key: "percent_off:20", kind: "percent_off", text: "20% off everything", percentOff: 20 }]]]),
      events: [{ storeId: "ct", kind: "price_drop", occurredAt: new Date(), title: "Hollywood Contour Wand", beforeCents: 4200, afterCents: 3800 }],
    });
    expect(market.summaries[0]).toEqual(expect.objectContaining({ products: 3, onOffer: 1, medianCents: 4400, medianOfferPercent: 10 }));
    const foundation = market.categories.find((c) => c.category === "Foundation")!;
    expect(foundation.byStore.get("sba")).toEqual({ count: 1, medianCents: 3200 });
    expect(market.offers.map((o) => o.percentOff)).toEqual([25, 10]);

    const html = renderMarketReport(market, { since: new Date("2026-10-22") });
    expect(html).toContain("Price by category");
    expect(html).toContain("€32.00");
    expect(html).toContain("20% off everything");
    expect(html).toContain("Price cut");
  });

  it("finds range gaps and price positions against your own store", () => {
    const sosu: Store = { id: "sosu", name: "SOSU", url: "https://sosu.example", kind: "merchant" };
    const market = buildMarket({
      stores: [sosu, ct, sba],
      products: new Map([
        ["sosu", [p("s1", "Studio Wear Foundation", 30), p("s2", "Eye Voltage Mascara", 15), p("s3", "Cream Contour Stick", 30)]],
        ["ct", [p("c1", "Instant Eye Palette", 56), p("c2", "Luxury Palette", 58), p("c3", "Pillow Talk Mascara", 34), p("c4", "Airbrush Flawless Foundation", 48)]],
        ["sba", [p("a1", "Pro Palette", 39), p("a2", "MyMascara", 23), p("a3", "Contour Stick", 25)]],
      ]),
      promotions: new Map(),
      events: [],
      merchantId: "sosu",
    });
    expect(market.gaps.map((g) => [g.category, g.yourCount])).toEqual([["Palettes", 0]]);
    const mascara = market.pricePositions.find((x) => x.category === "Mascara")!;
    expect(mascara).toEqual(expect.objectContaining({ signal: "headroom", gapPercent: -35 }));
    expect(mascara.cheapestRival.store.id).toBe("sba");
    expect(market.pricePositions.find((x) => x.category === "Contour")?.signal).toBe("above_rival");
    const html = renderMarketReport(market, { since: new Date("2026-10-22") });
    expect(html).toContain("Range gaps");
    expect(html).toContain("Room to raise");
  });
});

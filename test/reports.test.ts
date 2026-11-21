import { describe, expect, it } from "vitest";
import type { BriefItem } from "../src/brief/rank.js";
import type { ProductPosition, RivalPrice } from "../src/insights/position.js";
import { priceGapAlerts, promoAdvice, trackPromos, weeklyPriceMoves } from "../src/insights/reports.js";
import { formatCents } from "../src/money.js";
import type { ChangeEvent, Store } from "../src/types.js";

const DAY = 24 * 60 * 60 * 1000;
const day = (n: number) => new Date(Date.UTC(2026, 10, 1) + n * DAY);
const eur = (c: number) => formatCents(c, "EUR");

const rival = (storeName: string, priceCents: number, available = true): RivalPrice => ({
  storeId: storeName.toLowerCase(),
  storeName,
  title: "x",
  url: "https://x.example",
  priceCents,
  available,
  gapPercent: 0,
});
const position = (title: string, priceCents: number, rivals: RivalPrice[]): ProductPosition => ({
  product: { externalId: title, title, url: `https://sosu.example/${title}`, priceCents, available: true },
  rivals,
  position: "undercut",
});

describe("price gap alerts", () => {
  const report = priceGapAlerts([
    position("Serum", 3000, [rival("CT", 2700), rival("SbA", 3200)]),
    position("Lip kit", 2400, [rival("CT", 2000), rival("SbA", 2000)]),
    position("Brush", 1000, [rival("CT", 1200)]),
    position("Tan", 1500, [rival("CT", 1000, false)]),
    position("Level", 1000, [rival("CT", 998)]),
  ]);

  it("flags a cheaper rival with the gap in money and percent of their price", () => {
    expect(report.cheaperRivals).toEqual([
      expect.objectContaining({ title: "Serum", rivalName: "CT", rivalPriceCents: 2700, gapCents: 300, gapPercent: 11.1, rivalsCompared: 2 }),
    ]);
  });

  it("flags products well above the market average, measured against the average", () => {
    expect(report.pricedAbove).toEqual([
      expect.objectContaining({ title: "Lip kit", rivalName: "average of 2 rivals", rivalPriceCents: 2000, gapCents: 400, gapPercent: 20 }),
    ]);
  });

  it("ignores rivals out of stock, products you are cheapest on and prices within the level band", () => {
    const titles = [...report.cheaperRivals, ...report.pricedAbove].map((a) => a.title);
    expect(titles).not.toContain("Brush");
    expect(titles).not.toContain("Tan");
    expect(titles).not.toContain("Level");
  });

  it("names the rival when only one is in stock", () => {
    const one = priceGapAlerts([position("Serum", 3000, [rival("CT", 2500)])]);
    expect(one.pricedAbove[0]).toMatchObject({ rivalName: "CT", gapCents: 500, gapPercent: 20 });
  });
});

describe("promo tracker", () => {
  const stores: Store[] = [
    { id: "ct", name: "Charlotte Tilbury", url: "https://ct.example", kind: "competitor" },
    { id: "sba", name: "Sculpted by Aimee", url: "https://sba.example", kind: "competitor" },
  ];
  const ev = (storeId: string, kind: ChangeEvent["kind"], at: Date, title: string, promoKey: string, detail?: string): ChangeEvent => ({
    storeId,
    kind,
    occurredAt: at,
    title,
    promoKey,
    detail,
  });

  it("pairs starts with ends, merges one banner's promotions and adds what is running from before we watched", () => {
    const promos = trackPromos({
      stores,
      now: day(20),
      events: [
        ev("ct", "promo_started", day(1), "25% off everything with code GLOW", "percent_off:25"),
        ev("ct", "promo_started", day(1), "25% off everything with code GLOW", "discount_code:GLOW", "GLOW"),
        ev("ct", "promo_ended", day(6), "25% off everything with code GLOW", "percent_off:25"),
        ev("ct", "promo_ended", day(6), "25% off everything with code GLOW", "discount_code:GLOW", "GLOW"),
        ev("sba", "promo_started", day(15), "15% off brushes", "percent_off:15"),
      ],
      current: new Map([
        ["ct", [{ key: "free_shipping", kind: "free_shipping" as const, text: "Free shipping over €50", thresholdCents: 5000 }]],
        ["sba", [{ key: "percent_off:15", kind: "percent_off" as const, text: "15% off brushes", percentOff: 15 }]],
      ]),
    });

    expect(promos).toHaveLength(3);
    const [sba, ship, glow] = promos;
    expect(sba).toMatchObject({ storeName: "Sculpted by Aimee", running: true, startedAt: day(15), days: 5, percentOff: 15 });
    expect(ship).toMatchObject({ storeName: "Charlotte Tilbury", running: true, kind: "free_shipping" });
    expect(ship!.startedAt).toBeUndefined();
    expect(glow).toMatchObject({ running: false, startedAt: day(1), endedAt: day(6), days: 5, percentOff: 25, code: "GLOW" });
  });

  it("marks a promo as over when it is gone from the homepage but no end was recorded", () => {
    const [p] = trackPromos({
      stores,
      now: day(20),
      events: [ev("ct", "promo_started", day(1), "Black Friday", "sale_banner:black-friday")],
      current: new Map([["ct", []]]),
    });
    expect(p).toMatchObject({ running: false });
    expect(p!.endedAt).toBeUndefined();
    expect(p!.days).toBeUndefined();
  });

  it("gives match-or-skip advice by depth and kind", () => {
    expect(promoAdvice({ running: true, percentOff: 30 })).toMatch(/deep discount/);
    expect(promoAdvice({ running: true, percentOff: 15 })).toMatch(/Worth matching/);
    expect(promoAdvice({ running: true, percentOff: 5 })).toMatch(/safe to skip/);
    expect(promoAdvice({ running: true, kind: "discount_code", code: "X" })).toMatch(/only shoppers who find it/);
    expect(promoAdvice({ running: false, days: 4 })).toBe("Ran for 4 days. Useful for spotting how long their sales usually last.");
  });
});

describe("weekly brief price moves", () => {
  const item = (over: Partial<BriefItem> & { before: number; after: number; kind?: ChangeEvent["kind"] }): BriefItem => ({
    event: {
      storeId: "ct",
      kind: over.kind ?? (over.after < over.before ? "price_drop" : "price_increase"),
      occurredAt: day(1),
      title: "Their serum",
      beforeCents: over.before,
      afterCents: over.after,
    },
    competitor: "Charlotte Tilbury",
    score: 50,
    ...over,
  });

  it("shows a money figure only when sales at risk could be worked out", () => {
    const [m] = weeklyPriceMoves([item({ before: 3200, after: 2800, yourProduct: { title: "Glow Serum", priceCents: 3000 }, revenueAtRiskCents: 4500 })], eur);
    expect(m).toMatchObject({ direction: "down", changeCents: -400, changePercent: -12.5, valueCents: 4500 });
    expect(m!.noValueReason).toBeUndefined();
    expect(m!.reason).toBe("They now undercut your Glow Serum by €2.00.");
  });

  it("explains why there is no money figure", () => {
    const moves = weeklyPriceMoves(
      [
        item({ before: 3200, after: 2800, yourProduct: { title: "Glow Serum", priceCents: 3000 } }),
        item({ before: 3200, after: 3400, yourProduct: { title: "Glow Serum", priceCents: 3000 } }),
        item({ before: 3200, after: 2800 }),
      ],
      eur,
    );
    expect(moves.map((m) => m.valueCents)).toEqual([undefined, undefined, undefined]);
    expect(moves[0]!.noValueReason).toMatch(/weekly sales/);
    expect(moves[1]!.noValueReason).toMatch(/not cheaper than you/);
    expect(moves[1]!.reason).toBe("You are now €4.00 cheaper than them on Glow Serum. Say so in ads.");
    expect(moves[2]!.noValueReason).toMatch(/Not paired/);
  });

  it("keeps only price moves, in rank order, up to the limit", () => {
    const stock: BriefItem = { ...item({ before: 1000, after: 1000 }), event: { storeId: "ct", kind: "out_of_stock", occurredAt: day(1), title: "x" } };
    const moves = weeklyPriceMoves([stock, item({ before: 1000, after: 900 }), item({ before: 1000, after: 1100 }), item({ before: 500, after: 400 })], eur, 2);
    expect(moves.map((m) => m.direction)).toEqual(["down", "up"]);
  });
});

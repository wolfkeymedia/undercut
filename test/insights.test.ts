import { describe, expect, it } from "vitest";
import { sendAlerts } from "../src/alerts.js";
import { rankEvents } from "../src/brief/rank.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { parseEconomicsCsv } from "../src/costs.js";
import { buildScorecard } from "../src/insights/position.js";
import { recommendationsCsv, recommendPrices, roundPrice } from "../src/insights/pricing.js";
import { describePattern, promoPatterns } from "../src/insights/promos.js";
import type { ChangeEvent, ProductMatch, ProductSnapshot, Store } from "../src/types.js";

const stores: Store[] = [
  { id: "ridgeway", name: "Ridgeway Roasters", url: "https://ridgeway.example", kind: "competitor" },
  { id: "kettle", name: "Kettle Street", url: "https://kettle.example", kind: "competitor" },
];

const mine = (id: string, priceCents: number, extra: Partial<ProductSnapshot> = {}): ProductSnapshot => ({
  externalId: id,
  title: `Mine ${id}`,
  url: `https://northfield.example/products/mine-${id}`,
  priceCents,
  available: true,
  ...extra,
});
const theirs = (id: string, priceCents: number, available = true): ProductSnapshot => ({
  externalId: id,
  title: `Theirs ${id}`,
  url: `https://x.example/products/${id}`,
  priceCents,
  available,
});
const confirmed = (merchantExternalId: string, competitorStoreId: string, competitorExternalId: string): ProductMatch => ({
  merchantExternalId,
  competitorStoreId,
  competitorExternalId,
  confidence: 0.9,
  status: "confirmed",
});

function scorecardFixture() {
  return buildScorecard({
    merchantProducts: [
      mine("espresso", 3600, { costCents: 2000, unitsPerWeek: 40 }),
      mine("ethiopia", 1800, { costCents: 900, unitsPerWeek: 25 }),
      mine("decaf", 1500, { costCents: 700 }),
      mine("grinder", 9900),
    ],
    competitorProducts: new Map([
      ["ridgeway", [theirs("r-esp", 3250), theirs("r-eth", 2100), theirs("r-grind", 8000, false)]],
      ["kettle", [theirs("k-esp", 3700), theirs("k-dec", 1400)]],
    ]),
    stores,
    matches: [
      confirmed("espresso", "ridgeway", "r-esp"),
      confirmed("espresso", "kettle", "k-esp"),
      confirmed("ethiopia", "ridgeway", "r-eth"),
      confirmed("decaf", "kettle", "k-dec"),
      confirmed("grinder", "ridgeway", "r-grind"),
      { ...confirmed("ethiopia", "kettle", "k-dec"), status: "suggested" },
    ],
    config: DEFAULT_CONFIG,
  });
}

describe("scorecard", () => {
  const card = scorecardFixture();
  const pos = (id: string) => card.positions.find((p) => p.product.externalId === id)!;

  it("works out each product's position against the cheapest rival in stock", () => {
    expect(pos("espresso").position).toBe("undercut");
    expect(pos("espresso").cheapestRival?.storeName).toBe("Ridgeway Roasters");
    expect(pos("ethiopia").position).toBe("cheapest");
    expect(pos("decaf").position).toBe("undercut");
    expect(pos("grinder").position).toBe("no_rival_in_stock");
    // Suggested matches are ignored until confirmed.
    expect(pos("ethiopia").rivals).toHaveLength(1);
  });

  it("puts a money figure on undercuts when sales are known", () => {
    // Ridgeway is $3.50 (9.7%) cheaper; 2x sensitivity puts 19.4% of 40 units a week at risk.
    const share = (350 / 3600) * 2;
    expect(pos("espresso").revenueAtRiskCents).toBe(Math.round(40 * share * 3600)); // $280.00
    expect(pos("espresso").marginAtRiskCents).toBe(Math.round(40 * share * 1600));
    expect(pos("decaf").revenueAtRiskCents).toBeUndefined();
    expect(card.totals).toEqual(
      expect.objectContaining({ matchedProducts: 4, cheapest: 1, undercut: 2, noRivalInStock: 1, undercutWithoutSalesData: 1 }),
    );
    expect(card.totals.revenueAtRiskCents).toBe(pos("espresso").revenueAtRiskCents);
  });

  it("caps the share of sales at risk", () => {
    const big = buildScorecard({
      merchantProducts: [mine("a", 10000, { unitsPerWeek: 10 })],
      competitorProducts: new Map([["ridgeway", [theirs("r", 5000)]]]),
      stores,
      matches: [confirmed("a", "ridgeway", "r")],
      config: DEFAULT_CONFIG,
    });
    expect(big.positions[0]?.revenueAtRiskCents).toBe(10 * 0.6 * 10000);
  });

  it("computes a price index per competitor from in-stock shared products", () => {
    const ridgeway = card.indexes.find((i) => i.storeId === "ridgeway")!;
    expect(ridgeway.comparedProducts).toBe(2);
    expect(ridgeway.index).toBeCloseTo(Math.sqrt((3600 / 3250) * (1800 / 2100)) * 100, 1);
    const kettle = card.indexes.find((i) => i.storeId === "kettle")!;
    expect(kettle.index).toBeCloseTo(Math.sqrt((3600 / 3700) * (1500 / 1400)) * 100, 1);
  });
});

describe("price recommendations", () => {
  const card = scorecardFixture();
  const recs = recommendPrices(card.positions, DEFAULT_CONFIG.pricing);
  const rec = (id: string) => recs.find((r) => r.externalId === id);

  it("holds instead of cutting when the cut costs more margin than it protects", () => {
    // Cutting to $31.99 (1% under $32.50, rounded) earns 40 x $11.99 = $479.60 a week.
    // Doing nothing earns 40 x $16.00 = $640.00 minus $124.44 at risk = $515.56. Holding wins.
    expect(rec("espresso")).toEqual(
      expect.objectContaining({ action: "hold", currentCents: 3600, recommendedCents: 3600, consideredCents: 3199, weeklyMarginImpactCents: 47960 - 51556 }),
    );
    expect(rec("espresso")?.reason).toContain("would give up $160.40 a week in margin to protect about $124.44");
  });

  it("cuts when keeping the sales is worth more than the margin given up", () => {
    const [r] = recommendPrices(
      buildScorecard({
        merchantProducts: [mine("a", 2000, { costCents: 500, unitsPerWeek: 50 })],
        competitorProducts: new Map([["ridgeway", [theirs("r", 1700)]]]),
        stores,
        matches: [confirmed("a", "ridgeway", "r")],
        config: DEFAULT_CONFIG,
      }).positions,
      DEFAULT_CONFIG.pricing,
    );
    // 15% under puts 30% of sales at risk. The 15% step cap stops at $17.00, rounded to $16.99.
    expect(r).toEqual(expect.objectContaining({ action: "cut", recommendedCents: 1699, limitedBy: "max_change" }));
    expect(r?.weeklyMarginImpactCents).toBe(50 * 1199 - (50 * 1500 - 22500));
    expect(r?.reason).toContain("Worth about $74.50 a week more than doing nothing.");
  });

  it("cuts without a money figure when sales or cost are unknown", () => {
    expect(rec("decaf")).toEqual(expect.objectContaining({ action: "cut", recommendedCents: 1299, weeklyMarginImpactCents: undefined }));
  });

  it("raises prices where you are the cheapest, capped per step", () => {
    // Target is 1% under $21.00 = $20.79, but 15% over $18.00 caps it at $20.70, then $19.99.
    expect(rec("ethiopia")).toEqual(expect.objectContaining({ action: "raise", recommendedCents: 1999, limitedBy: "max_change" }));
    expect(rec("ethiopia")?.weeklyMarginImpactCents).toBe((1999 - 1800) * 25);
    expect(rec("ethiopia")?.reason).toContain("You are the cheapest");
  });

  it("stops at the margin floor", () => {
    const [r] = recommendPrices(
      buildScorecard({
        merchantProducts: [mine("a", 3200, { costCents: 2200 })],
        competitorProducts: new Map([["ridgeway", [theirs("r", 2600)]]]),
        stores,
        matches: [confirmed("a", "ridgeway", "r")],
        config: DEFAULT_CONFIG,
      }).positions,
      DEFAULT_CONFIG.pricing,
    );
    // 25% margin over $22.00 needs at least $29.34, so the nearest .99 at or above is $29.99.
    expect(r).toEqual(expect.objectContaining({ recommendedCents: 2999, limitedBy: "margin_floor" }));
    expect(r?.reason).toContain("as low as you can go");
  });

  it("holds prices while every matched rival is out of stock", () => {
    expect(rec("grinder")).toBeUndefined();
  });

  it("rounds to .99 without crossing the floor", () => {
    expect(roundPrice(3217.5, "99")).toBe(3199);
    expect(roundPrice(3299, "99")).toBe(3299);
    expect(roundPrice(2934, "99", 2934)).toBe(2999);
    expect(roundPrice(2934, "none", 2900)).toBe(2934);
  });

  it("exports recommendations as CSV with Shopify handles", () => {
    const csv = recommendationsCsv(recs);
    expect(csv.split("\n")[0]).toBe("handle,title,url,action,current_price,recommended_price,margin_percent,weekly_margin_impact,reason");
    expect(csv).toContain("mine-ethiopia,Mine ethiopia,https://northfield.example/products/mine-ethiopia,raise,18.00,19.99,55,49.75,");
    expect(csv).toContain("mine-espresso,Mine espresso,https://northfield.example/products/mine-espresso,hold,36.00,36.00,44.4,-35.96,");
  });
});

describe("promotion patterns", () => {
  const day = (d: number) => new Date(Date.UTC(2026, 7, 1) + d * 86400000);
  const promo = (storeId: string, d: number, key: string): ChangeEvent => ({
    storeId,
    kind: "promo_started",
    occurredAt: day(d),
    promoKey: key,
    title: key,
  });

  it("finds the rhythm and the next likely sale", () => {
    const patterns = promoPatterns(
      [
        promo("ridgeway", 0, "percent_off:20"),
        promo("ridgeway", 1, "discount_code:BREW20"),
        promo("ridgeway", 28, "percent_off:15"),
        promo("ridgeway", 56, "percent_off:20"),
        promo("kettle", 10, "sale_banner:flash sale"),
      ],
      stores,
    );
    const ridgeway = patterns.find((p) => p.storeId === "ridgeway")!;
    expect(ridgeway).toEqual(expect.objectContaining({ campaigns: 3, averageGapDays: 28, typicalPercentOff: 20 }));
    expect(ridgeway.expectedNextAt).toEqual(day(84));
    expect(describePattern(ridgeway, day(80))).toBe(
      "Ridgeway Roasters runs a promotion about every 28 days (typically 20% off). The next is due within a week, around Oct 24.",
    );
    const kettle = patterns.find((p) => p.storeId === "kettle")!;
    expect(kettle.campaigns).toBe(1);
    expect(describePattern(kettle)).toBeUndefined();
  });
});

describe("alerts", () => {
  const items = rankEvents({
    events: [
      { storeId: "ridgeway", kind: "price_drop", occurredAt: new Date(), externalId: "r-esp", title: "Espresso 1kg", beforeCents: 3800, afterCents: 3250 },
      { storeId: "kettle", kind: "new_product", occurredAt: new Date(), title: "Decaf", afterCents: 1400 },
    ],
    stores,
    matches: [confirmed("espresso", "ridgeway", "r-esp")],
    merchantProducts: [mine("espresso", 3600, { costCents: 2000, unitsPerWeek: 40 })],
  });

  it("sends only urgent changes, in one message Slack can show", async () => {
    const posted: { url: string; body: any }[] = [];
    const sent = await sendAlerts(
      items,
      { webhookUrl: "https://hooks.example/abc", minScore: 50, merchantName: "Northfield" },
      async (url, body) => (posted.push({ url, body }), { ok: true, status: 200 }),
    );
    expect(sent).toBe(1);
    expect(posted[0]?.url).toBe("https://hooks.example/abc");
    expect(posted[0]?.body.text).toContain("*Undercut alert for Northfield*: 1 competitor change needs attention");
    expect(posted[0]?.body.text).toContain("Ridgeway Roasters cut Espresso 1kg from $38.00 to $32.50");
    expect(posted[0]?.body.text).toContain("a week of your sales is at risk");
    expect(posted[0]?.body.items[0]).toEqual(expect.objectContaining({ kind: "price_drop", your_product: "Mine espresso" }));
  });

  it("does nothing without a webhook and reports a failing one", async () => {
    expect(await sendAlerts(items, { minScore: 0, merchantName: "N" }, async () => ({ ok: true, status: 200 }))).toBe(0);
    await expect(
      sendAlerts(items, { webhookUrl: "https://hooks.example/x", minScore: 0, merchantName: "N" }, async () => ({ ok: false, status: 404 })),
    ).rejects.toThrow("HTTP 404");
  });
});

describe("product economics CSV", () => {
  const products = [
    { externalId: "10", url: "https://n.example/products/espresso", title: "Espresso Blend 1kg" },
    { externalId: "11", url: "https://n.example/products/decaf", title: "Decaf, Swiss Water" },
  ];

  it("reads costs and weekly units, matching by title or url", () => {
    const csv = `title,cost,units_per_week\nEspresso Blend 1kg,$20.00,40\n"Decaf, Swiss Water",7.50,\nUnknown thing,1,1`;
    const { economics, unmatched } = parseEconomicsCsv(csv, products);
    expect(economics.get("10")).toEqual({ costCents: 2000, unitsPerWeek: 40 });
    expect(economics.get("11")).toEqual({ costCents: 750, unitsPerWeek: undefined });
    expect(unmatched).toEqual(["Unknown thing"]);
  });

  it("accepts a file with only sales figures", () => {
    const { economics } = parseEconomicsCsv(`url,weekly_units\nhttps://n.example/products/decaf,12`, products);
    expect(economics.get("11")).toEqual({ costCents: undefined, unitsPerWeek: 12 });
  });

  it("explains a bad header", () => {
    expect(() => parseEconomicsCsv(`name,price\nx,1`, products)).toThrow("needs a header");
  });
});

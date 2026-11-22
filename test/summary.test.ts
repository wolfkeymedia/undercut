import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildDemo } from "../src/demo.js";
import { buildSummary, CONNECT_SALES_NOTE, moveImpact } from "../src/insights/summary.js";
import { formatCents } from "../src/money.js";
import { buildInsights, type Insights } from "../src/pipeline.js";
import { renderSummary } from "../src/report/summary.js";

const money = (c: number) => formatCents(c, "EUR");

describe("impact rule", () => {
  it("shows a weekly total only when the client's own sales are known", () => {
    const withSales = moveImpact({ perUnitCents: 200, perUnit: "+€2.00 on each sale", unitsPerWeek: 42 }, money);
    expect(withSales.totalCents).toBe(8400);
    expect(withSales.total).toBe("About +€84.00 a week");
    expect(withSales.note).toBeUndefined();
  });

  it("falls back to the per-sale figure and asks to connect sales when they are missing", () => {
    const noSales = moveImpact({ perUnitCents: 200, perUnit: "+€2.00 on each sale" }, money);
    expect(noSales.totalCents).toBeUndefined();
    expect(noSales.total).toBeUndefined();
    expect(noSales.perUnit).toBe("+€2.00 on each sale");
    expect(noSales.note).toBe(CONNECT_SALES_NOTE);
  });

  it("ignores a ready-made total when the client's sales aren't connected", () => {
    // A total from anywhere else (a rival's sales, an old estimate) must never reach the card.
    const out = moveImpact({ perUnitCents: -150, perUnit: "€1.50 less", totalCents: 5000 }, money);
    expect(out.totalCents).toBeUndefined();
    expect(out.note).toBe(CONNECT_SALES_NOTE);
  });

  it("says what else is missing when sales are known but the total still can't be worked out", () => {
    const out = moveImpact({ perUnit: "€1.50 less", unitsPerWeek: 10, missingTotalNote: "Add your unit costs to see the total" }, money);
    expect(out.totalCents).toBeUndefined();
    expect(out.note).toBe("Add your unit costs to see the total");
  });
});

describe("report first page", () => {
  async function demoInsights(): Promise<Insights> {
    const { repo, lastWeek } = await buildDemo();
    return buildInsights(repo, DEFAULT_CONFIG, lastWeek);
  }

  it("lists what's going well, what needs attention and the moves with their impact", async () => {
    const insights = await demoInsights();
    const s = buildSummary(insights);
    expect(s.doingWell.length).toBeGreaterThan(0);
    expect(s.needsAttention.length).toBeGreaterThan(0);
    expect(s.moves.length).toBeGreaterThan(0);
    expect(s.moves.length).toBeLessThanOrEqual(6);
    for (const m of s.moves) {
      expect(m.title).not.toBe("");
      expect(m.why).not.toBe("");
      expect(m.impact.perUnit).not.toBe("");
      // Every card either has a total or says why not.
      expect(Boolean(m.impact.total) || Boolean(m.impact.note)).toBe(true);
    }
    // Rival promotions never carry a euro total: we can't know what matching would cost overall.
    for (const m of s.moves.filter((m) => m.kind === "promo")) expect(m.impact.totalCents).toBeUndefined();
  });

  it("drops every total once the client's sales are taken away", async () => {
    const insights = await demoInsights();
    const strip = <T extends { unitsPerWeek?: number }>(p: T): T => ({ ...p, unitsPerWeek: undefined });
    const noSales: Insights = {
      ...insights,
      merchantProducts: insights.merchantProducts.map(strip),
      scorecard: { ...insights.scorecard, positions: insights.scorecard.positions.map((p) => ({ ...p, product: strip(p.product) })) },
    };
    const s = buildSummary(noSales, { maxMoves: 100 });
    const priced = s.moves.filter((m) => m.kind !== "promo");
    expect(priced.length).toBeGreaterThan(0);
    for (const m of priced) {
      expect(m.impact.totalCents).toBeUndefined();
      expect(m.impact.note).toBe(CONNECT_SALES_NOTE);
    }
    const html = renderSummary(noSales, { weekOf: new Date(), detailsHref: "/r/abc/details" });
    expect(html).toContain(CONNECT_SALES_NOTE);
    expect(html).not.toContain("a week, if sales hold");
  });

  it("renders the cards with a link through to the details", async () => {
    const insights = await demoInsights();
    const html = renderSummary(insights, { weekOf: new Date(), detailsHref: "/r/abc/details" });
    expect(html).toContain("Doing well");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Potential impact");
    expect(html).toContain('href="/r/abc/details#prices"');
    expect(html).not.toContain("<table");
  });
});

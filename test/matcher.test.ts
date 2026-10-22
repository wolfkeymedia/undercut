import { describe, expect, it } from "vitest";
import { normalizeTitle, suggestMatches, titleSimilarity } from "../src/match/matcher.js";
import type { ProductSnapshot } from "../src/types.js";

const p = (id: string, title: string, priceCents = 3000): ProductSnapshot => ({
  externalId: id,
  title,
  url: `https://x.example/${id}`,
  priceCents,
  available: true,
});

describe("titles", () => {
  it("joins sizes to their units", () => {
    expect(normalizeTitle("Espresso Blend - 1 KG")).toEqual(["espresso", "blend", "1kg"]);
  });

  it("scores the same product higher than a different size", () => {
    const same = titleSimilarity("Espresso Blend 1kg", "Espresso Blend Coffee Beans 1 kg");
    const otherSize = titleSimilarity("Espresso Blend 1kg", "Espresso Blend 250g");
    expect(same).toBeGreaterThan(0.6);
    expect(otherSize).toBeLessThan(same - 0.3);
  });
});

describe("suggestMatches", () => {
  it("pairs each product with its closest counterpart, once", () => {
    const mine = [p("m1", "Espresso Blend 1kg", 3600), p("m2", "Ethiopia Yirgacheffe 250g", 1800), p("m3", "Ceramic Pour Over Dripper", 2500)];
    const theirs = [
      p("t1", "Espresso Blend Whole Bean 1kg", 3800),
      p("t2", "Ethiopian Yirgacheffe Single Origin 250g", 1700),
      p("t3", "Espresso Blend 250g", 1200),
    ];
    const matches = suggestMatches(mine, "ridgeway", theirs);
    const pairs = matches.map((m) => `${m.merchantExternalId}->${m.competitorExternalId}`).sort();
    expect(pairs).toEqual(["m1->t1", "m2->t2"]);
    expect(matches.every((m) => m.status === "suggested" && m.competitorStoreId === "ridgeway")).toBe(true);
  });
});

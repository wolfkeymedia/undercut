#!/usr/bin/env node
/**
 * Builds a realistic sample store with three competitors and writes the report
 * and brief a manager would get, with no database or network needed. Use it to
 * see the product, or to demo it to a prospect.
 *
 *   npm run demo                # writes demo-report.html and demo-brief.md
 */
import { writeFile } from "node:fs/promises";
import { DEFAULT_CONFIG } from "./config.js";
import { buildBrief } from "./pipeline.js";
import { renderReport } from "./report/html.js";
import { MemoryRepository } from "./store/memory.js";
import { suggestMatches } from "./match/matcher.js";
import { detectChanges } from "./detect/changes.js";
import type { ChangeEvent, ProductSnapshot, Store, StoreObservation } from "./types.js";

const DAY = 24 * 60 * 60 * 1000;

const merchant: Store = { id: "northfield", name: "Northfield Coffee Co.", url: "https://northfield.example", kind: "merchant" };
const rivals: Store[] = [
  { id: "ridgeway", name: "Ridgeway Roasters", url: "https://ridgeway.example", kind: "competitor" },
  { id: "kettle", name: "Kettle Street", url: "https://kettle.example", kind: "competitor" },
  { id: "bean-barrow", name: "Bean & Barrow", url: "https://beanandbarrow.example", kind: "competitor" },
];

// title, price, unit cost, units a week
const catalog: [string, number, number, number][] = [
  ["Espresso Blend 1kg", 3600, 2000, 40],
  ["House Blend 1kg", 3200, 1750, 55],
  ["Ethiopia Yirgacheffe 250g", 1800, 900, 25],
  ["Colombia Huila 250g", 1650, 820, 30],
  ["Decaf Swiss Water 250g", 1500, 760, 18],
  ["Cold Brew Coarse Grind 500g", 2100, 1100, 22],
  ["Guatemala Antigua 250g", 1700, 850, 12],
  ["Burr Coffee Grinder", 9900, 5600, 6],
  ["Ceramic Pour Over Dripper", 2800, 1100, 9],
  ["Paper Filters 100 Pack", 900, 280, 35],
];

// What each rival sold a week ago, and what changed since. [title, before, after, inStockBefore, inStockAfter]
const rivalCatalogs: Record<string, [string, number, number, boolean?, boolean?][]> = {
  ridgeway: [
    ["Espresso Blend Whole Bean 1kg", 3800, 3250],
    ["House Blend Coffee 1kg", 3150, 3150],
    ["Ethiopian Yirgacheffe Single Origin 250g", 1700, 1700, true, false],
    ["Colombia Huila Single Origin 250g", 1690, 1550],
    ["Burr Grinder Coffee", 10900, 10900],
  ],
  kettle: [
    ["Espresso Blend 1kg", 3700, 3700],
    ["Decaf Swiss Water Process 250g", 1450, 1390],
    ["Cold Brew Grind 500g", 2400, 2400],
    ["Guatemala Antigua Coffee 250g", 1990, 1990],
    ["Pour Over Dripper Ceramic", 3200, 3400],
  ],
  "bean-barrow": [
    ["House Blend 1kg", 3400, 3400],
    ["Paper Filters 100 pack", 1100, 1100],
    ["Colombia Huila 250g", 1750, 1750, true, true],
  ],
};

export async function buildDemo(now = new Date()) {
  const repo = new MemoryRepository();
  const lastWeek = new Date(now.getTime() - 7 * DAY);
  await repo.upsertStore(merchant);
  for (const r of rivals) await repo.upsertStore(r);

  const mine: ProductSnapshot[] = catalog.map(([title, price], i) => ({
    externalId: String(1000 + i),
    title,
    url: `${merchant.url}/products/${slug(title)}`,
    priceCents: price,
    available: true,
    currency: "USD",
  }));
  await repo.saveObservation({ storeId: merchant.id, observedAt: now, products: mine, promotions: [], source: "shopify_feed" });
  await repo.setEconomics(
    merchant.id,
    new Map(catalog.map(([, , cost, units], i) => [String(1000 + i), { costCents: cost, unitsPerWeek: units }])),
  );

  for (const rival of rivals) {
    const rows = rivalCatalogs[rival.id]!;
    const snapshot = (when: "before" | "after"): ProductSnapshot[] =>
      rows.map(([title, before, after, stockBefore = true, stockAfter = stockBefore], i) => ({
        externalId: `${rival.id}-${i}`,
        title,
        url: `${rival.url}/products/${slug(title)}`,
        priceCents: when === "before" ? before : after,
        available: when === "before" ? stockBefore : stockAfter,
        currency: "USD",
      }));
    const before: StoreObservation = { storeId: rival.id, observedAt: lastWeek, products: snapshot("before"), promotions: [], source: "shopify_feed" };
    const after: StoreObservation = {
      storeId: rival.id,
      observedAt: new Date(now.getTime() - 2 * DAY),
      products: snapshot("after"),
      promotions:
        rival.id === "bean-barrow"
          ? [
              { key: "percent_off:20", kind: "percent_off", percentOff: 20, text: "20% off sitewide with code BREW20" },
              { key: "discount_code:BREW20", kind: "discount_code", code: "BREW20", text: "20% off sitewide with code BREW20" },
            ]
          : rival.id === "kettle"
            ? [{ key: "free_shipping:4000", kind: "free_shipping", thresholdCents: 4000, text: "Free shipping on orders over $40" }]
            : [],
      source: "shopify_feed",
    };
    await repo.saveObservation(before);
    await repo.saveObservation(after);
    await repo.saveEvents(detectChanges(before, after));
    // Auto-confirm the demo matches; a real merchant reviews them first.
    for (const m of suggestMatches(mine, rival.id, after.products)) {
      await repo.saveSuggestedMatches([m]);
      await repo.setMatchStatus(m, "confirmed");
    }
  }

  // A few months of Bean & Barrow promotions so the forecast has a rhythm to find.
  const history: ChangeEvent[] = [86, 58, 30].map((daysAgo) => ({
    storeId: "bean-barrow",
    kind: "promo_started",
    occurredAt: new Date(now.getTime() - daysAgo * DAY),
    promoKey: "percent_off:20",
    title: "20% off sitewide",
  }));
  await repo.saveEvents(history);

  return { repo, lastWeek };
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

if (process.argv[1]?.endsWith("demo.ts") || process.argv[1]?.endsWith("demo.js")) {
  const { repo, lastWeek } = await buildDemo();
  const { markdown, insights } = await buildBrief(repo, lastWeek, new Date(), DEFAULT_CONFIG);
  await writeFile("demo-report.html", renderReport(insights, DEFAULT_CONFIG, { weekOf: lastWeek, sample: true }));
  await writeFile("demo-brief.md", markdown + "\n");
  console.log("Wrote demo-report.html and demo-brief.md for a sample coffee store.");
}

import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { collapse, rankEvents } from "../src/brief/rank.js";
import { renderPlainBrief, writeBrief } from "../src/brief/write.js";
import { buildBrief, checkStore, pairProducts, refreshMatches, sameProductUrl } from "../src/pipeline.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { renderReport } from "../src/report/html.js";
import { MemoryRepository } from "../src/store/memory.js";
import type { ChangeEvent, Store } from "../src/types.js";
import { fakeFetcher, shopifyFeed } from "./helpers.js";

const merchant: Store = { id: "northfield", name: "Northfield Coffee Co.", url: "https://northfield.example", kind: "merchant" };
const ridgeway: Store = { id: "ridgeway", name: "Ridgeway Roasters", url: "https://ridgeway.example", kind: "competitor" };
const feedUrl = (s: Store) => `${s.url}/products.json?limit=250&page=1`;

describe("end to end", () => {
  it("collects twice, matches products and writes a brief about what changed", async () => {
    const repo = new MemoryRepository();
    await repo.upsertStore(merchant);
    await repo.upsertStore(ridgeway);

    let ridgewayFeed = shopifyFeed([
      { id: 1, title: "Espresso Blend Whole Bean 1kg", price: "38.00" },
      { id: 2, title: "Ethiopian Yirgacheffe 250g", price: "17.00" },
    ]);
    let ridgewayHome = "<header>Welcome</header>";
    const fetcher = fakeFetcher({
      [feedUrl(merchant)]: shopifyFeed([
        { id: 10, title: "Espresso Blend 1kg", price: "36.00" },
        { id: 11, title: "Ethiopia Yirgacheffe 250g", price: "18.00" },
      ]),
      [feedUrl(ridgeway)]: () => ridgewayFeed,
      [`${ridgeway.url}/`]: () => ridgewayHome,
    });

    const start = new Date(Date.now() - 1000);
    await checkStore(repo, fetcher, merchant);
    await checkStore(repo, fetcher, ridgeway);
    expect(await refreshMatches(repo)).toBe(2);
    for (const m of await repo.listMatches("suggested")) await repo.setMatchStatus(m, "confirmed");
    await repo.setEconomics(merchant.id, new Map([["10", { costCents: 2000, unitsPerWeek: 40 }]]));

    // A week later: Ridgeway undercuts on espresso, sells out of Ethiopia and starts a sale.
    ridgewayFeed = shopifyFeed([
      { id: 1, title: "Espresso Blend Whole Bean 1kg", price: "32.50" },
      { id: 2, title: "Ethiopian Yirgacheffe 250g", price: "17.00", available: false },
    ]);
    ridgewayHome = `<div class="announcement">20% off sitewide with code BREW20</div>`;
    const { events } = await checkStore(repo, fetcher, ridgeway);
    expect(events.map((e) => e.kind).sort()).toEqual(["out_of_stock", "price_drop", "promo_started", "promo_started"]);

    const { markdown, writer, insights } = await buildBrief(repo, start);
    expect(writer).toBe("template");
    expect(markdown).toContain("About $280.00 a week of your sales is exposed to cheaper competitors ($124.44 of margin).");
    expect(markdown).toContain("## Prices to change");
    expect(markdown).toContain("Espresso Blend 1kg: hold at $36.00.");
    expect(markdown).toContain("Ridgeway Roasters cut Espresso Blend Whole Bean 1kg from $38.00 to $32.50 (-14%). That is $3.50 below your Espresso Blend 1kg.");
    expect(markdown).toContain("Matching at $32.50 would give up $140.00 a week in margin to protect about $124.44.");
    expect(markdown).toContain("Feature Ethiopia Yirgacheffe 250g on your homepage");
    // The undercut on a matched product outranks everything else.
    expect(markdown.indexOf("cut Espresso")).toBeLessThan(markdown.indexOf("out of stock"));

    const html = renderReport(insights, DEFAULT_CONFIG, { weekOf: start });
    expect(html).toContain("<title>Northfield Coffee Co. · Undercut weekly report</title>");
    expect(html).toContain("$280.00");
    expect(html).toContain("Prices to change this week");
    expect(html).toContain('<span class="pill neutral">Hold</span>');
    expect(html).toContain("saves $35.56");
    expect(html).toContain("Rivals out of stock");
  });
});

describe("ranking", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 9, day));
  const ev = (e: Partial<ChangeEvent>): ChangeEvent => ({ storeId: "ridgeway", kind: "price_drop", occurredAt: at(1), title: "X", ...e });

  it("nets several price moves on one product into one", () => {
    const out = collapse([
      ev({ externalId: "1", kind: "price_drop", beforeCents: 1000, afterCents: 800, occurredAt: at(1) }),
      ev({ externalId: "1", kind: "price_increase", beforeCents: 800, afterCents: 900, occurredAt: at(3) }),
    ]);
    expect(out).toEqual([expect.objectContaining({ kind: "price_drop", beforeCents: 1000, afterCents: 900 })]);
  });

  it("drops a price that went down and came back", () => {
    const out = collapse([
      ev({ externalId: "1", kind: "price_drop", beforeCents: 1000, afterCents: 800, occurredAt: at(1) }),
      ev({ externalId: "1", kind: "price_increase", beforeCents: 800, afterCents: 1000, occurredAt: at(2) }),
    ]);
    expect(out).toEqual([]);
  });

  it("reports one promotion per banner, keeping the code", () => {
    const text = "20% off sitewide with code BREW20";
    const out = collapse([
      ev({ kind: "promo_started", promoKey: "discount_code:BREW20", title: text, detail: "BREW20" }),
      ev({ kind: "promo_started", promoKey: "percent_off:20", title: text }),
    ]);
    expect(out).toEqual([expect.objectContaining({ promoKey: "percent_off:20", detail: "BREW20" })]);
  });

  it("says how much cheaper you are after a rival raises its price", () => {
    const [item] = rankEvents({
      events: [ev({ externalId: "1", kind: "price_increase", beforeCents: 3200, afterCents: 3400 })],
      stores: [ridgeway],
      matches: [{ merchantExternalId: "10", competitorStoreId: "ridgeway", competitorExternalId: "1", confidence: 0.9, status: "confirmed" }],
      merchantProducts: [{ externalId: "10", title: "Dripper", url: "u", priceCents: 2800, available: true }],
    });
    expect(item?.suggestion).toBe("You are now $6.00 cheaper on Dripper. Say so in ads and on the product page.");
  });

  it("warns against matching a price that would wreck the margin", () => {
    const items = rankEvents({
      events: [ev({ externalId: "1", beforeCents: 3800, afterCents: 2400 })],
      stores: [ridgeway],
      matches: [{ merchantExternalId: "10", competitorStoreId: "ridgeway", competitorExternalId: "1", confidence: 0.9, status: "confirmed" }],
      merchantProducts: [{ externalId: "10", title: "Espresso", url: "u", priceCents: 3600, available: true, costCents: 2000 }],
    });
    expect(items[0]?.suggestion).toBe(
      "Matching at $24.00 would cut your margin to 17%. Hold your price and compete on value, bundles or shipping instead.",
    );
  });
});

describe("brief writer", () => {
  const items = rankEvents({
    events: [{ storeId: "ridgeway", kind: "new_product", occurredAt: new Date(), title: "Decaf 250g", afterCents: 1500 }],
    stores: [ridgeway],
    matches: [],
    merchantProducts: [],
  });
  const ctx = { merchantName: "Northfield", weekOf: new Date("2026-10-19") };

  function fakeClient(response: Partial<Anthropic.Beta.BetaMessage>) {
    const calls: unknown[] = [];
    const client = { beta: { messages: { create: async (body: unknown) => (calls.push(body), response) } } };
    return { client: client as unknown as Anthropic, calls };
  }

  it("uses Claude's text and sends only the computed facts", async () => {
    const { client, calls } = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: "Quiet week.", citations: null }] });
    const out = await writeBrief(items, ctx, client);
    expect(out).toEqual({ markdown: "Quiet week.", writer: "claude" });
    const body = calls[0] as { model: string; messages: { content: string }[] };
    expect(body.model).toBe("claude-opus-5-5");
    expect(JSON.parse(body.messages[0]!.content).facts[0].fact).toBe("Ridgeway Roasters added Decaf 250g at $15.00.");
  });

  it("falls back to the template when Claude declines", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", content: [] });
    const out = await writeBrief(items, ctx, client);
    expect(out).toEqual({ markdown: renderPlainBrief(items, ctx), writer: "template" });
  });
});

describe("pairing products by hand", () => {
  it("pairs equivalent products, reading the competitor page if needed, and tracks it on later runs", async () => {
    const repo = new MemoryRepository();
    const mine: Store = { id: "glow", name: "Glow Cosmetics", url: "https://glow.example", kind: "merchant" };
    const ct: Store = { id: "ct", name: "Charlotte's", url: "https://www.ct.example", kind: "competitor" };
    await repo.upsertStore(mine);
    await repo.upsertStore(ct);
    const pageUrl = "https://www.ct.example/us/product/contour-wand";
    const page = `<script type="application/ld+json">{"@type":"Product","name":"Contour Wand","sku":"CW-1","offers":{"price":"38.00"}}</script>`;
    const fetcher = fakeFetcher({
      [feedUrl(mine)]: shopifyFeed([{ id: 7, title: "Sculpt Stick", price: "28.00" }]),
      [pageUrl]: page,
      [`${ct.url}/`]: "<header>Hi</header>",
    });
    await checkStore(repo, fetcher, mine);

    const { yours, theirs } = await pairProducts(repo, fetcher, "https://glow.example/products/sculpt-stick?variant=1", pageUrl);
    expect(yours.title).toBe("Sculpt Stick");
    expect(theirs).toEqual(expect.objectContaining({ externalId: "CW-1", priceCents: 3800 }));
    expect(await repo.listMatches("confirmed")).toEqual([
      expect.objectContaining({ merchantExternalId: "7", competitorStoreId: "ct", competitorExternalId: "CW-1", confidence: 1 }),
    ]);

    // The competitor has no Shopify feed or sitemap, so only the tracked page keeps the pair priced.
    const { observation } = await checkStore(repo, fetcher, ct);
    expect(observation.products.map((p) => p.externalId)).toEqual(["CW-1"]);
  });

  it("explains what's missing", async () => {
    const repo = new MemoryRepository();
    await expect(pairProducts(repo, fakeFetcher({}), "https://a.example/p", "https://b.example/p")).rejects.toThrow("Add your store first");
  });
});

describe("sameProductUrl", () => {
  it("ignores query, fragment, trailing slash and www", () => {
    expect(sameProductUrl("https://www.x.example/products/a/?v=1#top", "https://x.example/products/a")).toBe(true);
    expect(sameProductUrl("https://x.example/products/a", "https://x.example/products/b")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { collectStore } from "../src/collectors/index.js";
import { detectPromotions } from "../src/collectors/promotions.js";
import { collectShopifyFeed } from "../src/collectors/shopify.js";
import { discoverProductUrls, extractStructuredProduct } from "../src/collectors/structured.js";
import { fakeFetcher, shopifyFeed } from "./helpers.js";

const ORIGIN = "https://ridgeway.example";

describe("Shopify feed", () => {
  it("reads products and picks the cheapest available variant", async () => {
    const feed = JSON.stringify({
      products: [
        {
          id: 1,
          title: "Espresso Blend 1kg",
          handle: "espresso-blend-1kg",
          variants: [
            { price: "38.00", compare_at_price: "42.00", available: true },
            { price: "30.00", available: false },
          ],
        },
      ],
    });
    const fetcher = fakeFetcher({ [`${ORIGIN}/products.json?limit=250&page=1`]: feed });
    const products = await collectShopifyFeed(fetcher, ORIGIN);
    expect(products).toEqual([
      expect.objectContaining({
        externalId: "1",
        url: `${ORIGIN}/products/espresso-blend-1kg`,
        priceCents: 3800,
        compareAtCents: 4200,
        available: true,
      }),
    ]);
  });

  it("follows pages until one comes back short", async () => {
    const page1 = shopifyFeed(Array.from({ length: 250 }, (_, i) => ({ id: i, title: `P${i}`, price: "10.00" })));
    const page2 = shopifyFeed([{ id: 999, title: "Last", price: "5.00" }]);
    const fetcher = fakeFetcher({
      [`${ORIGIN}/products.json?limit=250&page=1`]: page1,
      [`${ORIGIN}/products.json?limit=250&page=2`]: page2,
    });
    const products = await collectShopifyFeed(fetcher, ORIGIN);
    expect(products).toHaveLength(251);
    expect(fetcher.calls).toHaveLength(2);
  });

  it("returns null for stores that are not on Shopify", async () => {
    const fetcher = fakeFetcher({ [`${ORIGIN}/products.json?limit=250&page=1`]: "<html>Not here</html>" });
    expect(await collectShopifyFeed(fetcher, ORIGIN)).toBeNull();
  });
});

describe("structured product data", () => {
  it("reads a Product inside @graph with an AggregateOffer", () => {
    const html = `<html><head>
      <link rel="canonical" href="/product/house-blend">
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
        {"@type":"WebPage","name":"House Blend"},
        {"@type":"Product","name":"House Blend 500g","sku":"HB-500","brand":{"@type":"Brand","name":"Kettle Street"},
         "image":["https://img.example/hb.jpg"],
         "offers":{"@type":"AggregateOffer","lowPrice":"18.50","highPrice":"22.00","priceCurrency":"USD","availability":"https://schema.org/InStock"}}
      ]}</script></head><body></body></html>`;
    const product = extractStructuredProduct(html, "https://kettle.example/product/house-blend?ref=x");
    expect(product).toEqual(
      expect.objectContaining({
        externalId: "HB-500",
        title: "House Blend 500g",
        url: "https://kettle.example/product/house-blend",
        vendor: "Kettle Street",
        imageUrl: "https://img.example/hb.jpg",
        priceCents: 1850,
        currency: "USD",
        available: true,
      }),
    );
  });

  it("marks products out of stock", () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"Decaf","offers":[{"@type":"Offer","price":12,"availability":"http://schema.org/OutOfStock"}]}</script>`;
    expect(extractStructuredProduct(html, "https://x.example/p/decaf")).toEqual(
      expect.objectContaining({ priceCents: 1200, available: false, externalId: "https://x.example/p/decaf" }),
    );
  });

  it("skips broken JSON-LD and returns null without a product", () => {
    const html = `<script type="application/ld+json">{oops</script><script type="application/ld+json">{"@type":"Organization"}</script>`;
    expect(extractStructuredProduct(html, "https://x.example/")).toBeNull();
  });

  it("finds product URLs through a sitemap index", async () => {
    const fetcher = fakeFetcher({
      "https://kettle.example/sitemap.xml": `<?xml version="1.0"?><sitemapindex>
        <sitemap><loc>https://kettle.example/sitemap-pages.xml</loc></sitemap>
        <sitemap><loc>https://kettle.example/sitemap-products.xml</loc></sitemap></sitemapindex>`,
      "https://kettle.example/sitemap-products.xml": `<?xml version="1.0"?><urlset>
        <url><loc>https://kettle.example/house-blend</loc></url>
        <url><loc>https://kettle.example/decaf</loc></url></urlset>`,
    });
    expect(await discoverProductUrls(fetcher, "https://kettle.example")).toEqual([
      "https://kettle.example/house-blend",
      "https://kettle.example/decaf",
    ]);
    expect(fetcher.calls).not.toContain("https://kettle.example/sitemap-pages.xml");
  });
});

describe("promotions", () => {
  it("finds percent off, codes, free shipping and named sales in banners", () => {
    const html = `<html><body>
      <div class="announcement-bar">BLACK FRIDAY: 25% off sitewide with code BREW25 | Free shipping on orders over $50</div>
      <main><p>Our story began in 2012.</p></main></body></html>`;
    const promos = detectPromotions(html);
    const keys = promos.map((p) => p.key).sort();
    expect(keys).toEqual(["discount_code:BREW25", "free_shipping:5000", "percent_off:25", "sale_banner:black friday"]);
    expect(promos.find((p) => p.kind === "free_shipping")?.thresholdCents).toBe(5000);
  });

  it("finds nothing on a page without offers", () => {
    expect(detectPromotions("<html><body><header>Welcome to our shop</header></body></html>")).toEqual([]);
  });
});

describe("collectStore", () => {
  it("falls back to product pages when there is no Shopify feed", async () => {
    const origin = "https://kettle.example";
    const fetcher = fakeFetcher({
      [`${origin}/sitemap.xml`]: `<urlset><url><loc>${origin}/products/decaf</loc></url></urlset>`,
      [`${origin}/products/decaf`]: `<script type="application/ld+json">{"@type":"Product","name":"Decaf 250g","offers":{"price":"9.00"}}</script>`,
      [`${origin}/`]: `<div class="promo">Flash sale: 10% off everything</div>`,
    });
    const obs = await collectStore(fetcher, { id: "kettle", name: "Kettle", url: origin, kind: "competitor" });
    expect(obs.source).toBe("structured_data");
    expect(obs.products.map((p) => p.title)).toEqual(["Decaf 250g"]);
    expect(obs.promotions.map((p) => p.key).sort()).toEqual(["percent_off:10", "sale_banner:flash sale"]);
  });
});

import { describe, expect, it } from "vitest";
import { collectStore } from "../src/collectors/index.js";
import { detectPromotions } from "../src/collectors/promotions.js";
import { collectShopifyFeed } from "../src/collectors/shopify.js";
import { discoverProductUrls, extractStructuredProduct, stripSiteName, tidyTitle } from "../src/collectors/structured.js";
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

  it("skips free variants", async () => {
    const feed = JSON.stringify({
      products: [
        { id: 1, title: "Gift Box", handle: "gift-box", variants: [{ price: "0.00", available: true }] },
        { id: 2, title: "Lip Kit", handle: "lip-kit", variants: [{ price: "0.00" }, { price: "32.00" }] },
      ],
    });
    const fetcher = fakeFetcher({ [`${ORIGIN}/products.json?limit=250&page=1`]: feed });
    expect(await collectShopifyFeed(fetcher, ORIGIN)).toEqual([expect.objectContaining({ externalId: "2", priceCents: 3200 })]);
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

  it("reads the page's own product from Next.js data, not the recommendations", () => {
    const data = {
      props: { pageProps: { product: { slug: "airbrush-flawless-foundation", sku: "FF-1", title: "Airbrush Flawless Foundation",
        price: { purchasePrice: { value: 44 }, listingPrice: { value: 49 } }, availability: "IN_STOCK" },
        related: [{ slug: "magic-cream", title: "Magic Cream", price: { purchasePrice: { value: 85 } } }] } },
    };
    const html = `<html><head><meta property="og:title" content="Airbrush Flawless Foundation | Charlotte Tilbury"></head><body>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
    expect(extractStructuredProduct(html, "https://ct.example/ie/product/airbrush-flawless-foundation")).toEqual(
      expect.objectContaining({ externalId: "FF-1", title: "Airbrush Flawless Foundation", priceCents: 4400, compareAtCents: 4900, available: true }),
    );
  });

  it("reads a visible price, ignoring upsell boxes and was-prices outside it", () => {
    const html = `<html><head><meta property="og:title" content="Sculpt Stick | Brand"></head><body>
      <h1>Sculpt Stick</h1>
      <div class="product-price"><span>€28.00</span></div>
      <div class="price-rrp">€35.00</div>
      <div class="BundleUpsell"><span class="price">€60.00</span><del class="price">€80.00</del></div>
      </body></html>`;
    const product = extractStructuredProduct(html, "https://brand.example/ie/sculpt-stick");
    expect(product).toEqual(expect.objectContaining({ title: "Sculpt Stick", priceCents: 2800, currency: "EUR" }));
    expect(product?.compareAtCents).toBeUndefined();
  });

  it("takes a was-price only from inside the chosen price", () => {
    const html = `<html><body><h1>Brow Gel</h1><div class="price"><del>€20.00</del> <ins>€15.00</ins></div></body></html>`;
    expect(extractStructuredProduct(html, "https://brand.example/brow-gel")).toEqual(
      expect.objectContaining({ priceCents: 1500, compareAtCents: 2000 }),
    );
  });

  it("tidies ALL CAPS titles and adds the shade from Next.js data", () => {
    const data = { props: { pageProps: { product: { slug: "airbrush-brightening-flawless-finish-tan-deep", sku: "AB-TD",
      title: "AIRBRUSH BRIGHTENING FLAWLESS FINISH", shade: { name: "TAN-DEEP" }, price: { purchasePrice: { value: 54 } } } } } };
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
    expect(extractStructuredProduct(html, "https://ct.example/ie/product/airbrush-brightening-flawless-finish-tan-deep")?.title).toBe(
      "Airbrush Brightening Flawless Finish – Tan-Deep",
    );
    expect(tidyTitle("PILLOW TALK LIP KIT WITH SPF 15")).toBe("Pillow Talk Lip Kit with SPF 15");
    expect(tidyTitle("Magic Cream")).toBe("Magic Cream");
  });

  it("strips the site name from titles", () => {
    expect(stripSiteName("Pillow Talk Lipstick | Charlotte Tilbury")).toBe("Pillow Talk Lipstick");
    expect(stripSiteName("Contour Kit - Sculpted by Aimee", "Sculpted by Aimee")).toBe("Contour Kit");
    expect(stripSiteName("Glow-Up Duo")).toBe("Glow-Up Duo");
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

  it("ignores menu links that mention sales", () => {
    const html = `<html><body><nav class="megamenu"><a>Black Friday</a><a>20% off gifts</a></nav>
      <main><p>New season shades</p></main></body></html>`;
    expect(detectPromotions(html)).toEqual([]);
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

  it("takes a Shopify store's currency from its homepage", async () => {
    const fetcher = fakeFetcher({
      [`${ORIGIN}/products.json?limit=250&page=1`]: shopifyFeed([{ id: 1, title: "Contour Kit", price: "30.00" }]),
      [`${ORIGIN}/`]: `<script>Shopify.currency = {"active":"EUR","rate":"1.0"};</script>`,
    });
    const obs = await collectStore(fetcher, { id: "sba", name: "SbA", url: ORIGIN, kind: "competitor" });
    expect(obs.products[0]?.currency).toBe("EUR");
  });
});

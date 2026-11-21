import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { collectStore } from "../src/collectors/index.js";
import { browserRenderer, type Renderer } from "../src/collectors/render.js";
import { discoverProductUrls, extractStructuredProduct } from "../src/collectors/structured.js";
import { fakeFetcher } from "./helpers.js";

// Shaped like a store that fills prices in with JavaScript: the HTML as downloaded holds placeholders.
const templatePage = (title: string) => `<html><head><title>${title}</title></head><body>
  <h1>${title}</h1><div class="product-price">{{price}}</div><button>Add to bag</button></body></html>`;
const renderedPage = (title: string, price: string, was?: string) => `<html><head><title>${title}</title>
  <link rel="canonical" href="https://brand.example/ie/product/${title.toLowerCase().replace(/ /g, "-")}"></head><body>
  <h1>${title}</h1><div class="product-price"><span class="price-now">${price}</span>${was ? `<s class="price-was">${was}</s>` : ""}</div></body></html>`;

describe("pages without JSON-LD", () => {
  it("reads Open Graph product tags", () => {
    const html = `<head><meta property="og:title" content="Airbrush Setting Spray"><meta property="product:price:amount" content="38.00">
      <meta property="product:price:currency" content="EUR"><meta property="product:availability" content="out of stock"></head>`;
    expect(extractStructuredProduct(html, "https://brand.example/ie/product/spray")).toEqual(
      expect.objectContaining({ title: "Airbrush Setting Spray", priceCents: 3800, currency: "EUR", available: false }),
    );
  });

  it("reads the visible price and was-price, and ignores unfilled templates", () => {
    expect(extractStructuredProduct(templatePage("Contour Wand"), "https://brand.example/ie/product/contour-wand")).toBeNull();
    expect(extractStructuredProduct(renderedPage("Contour Wand", "€38,00", "€45,00"), "https://brand.example/x")).toEqual(
      expect.objectContaining({
        title: "Contour Wand",
        url: "https://brand.example/ie/product/contour-wand",
        priceCents: 3800,
        compareAtCents: 4500,
        currency: "EUR",
        available: true,
      }),
    );
  });
});

describe("regional stores", () => {
  const routes = {
    "https://brand.example/robots.txt": "User-agent: *\nDisallow: /checkout\nSitemap: https://brand.example/uk/sitemap_index.xml\nSitemap: https://brand.example/ie/sitemap_index.xml",
    "https://brand.example/ie/sitemap_index.xml": `<sitemapindex>
      <sitemap><loc>https://brand.example/ie/ie_makeup_sitemap.xml</loc></sitemap>
      <sitemap><loc>https://brand.example/ie/ie_content_sitemap.xml</loc></sitemap></sitemapindex>`,
    "https://brand.example/ie/ie_makeup_sitemap.xml": `<urlset>
      <url><loc>https://brand.example/ie/product/contour-wand</loc></url>
      <url><loc>https://brand.example/ie/product/pillow-talk-lipstick</loc></url></urlset>`,
    "https://brand.example/ie/ie_content_sitemap.xml": `<urlset><url><loc>https://brand.example/ie/about-us</loc></url></urlset>`,
    "https://brand.example/uk/sitemap_index.xml": `<sitemapindex><sitemap><loc>https://brand.example/uk/uk_makeup_sitemap.xml</loc></sitemap></sitemapindex>`,
  };

  it("uses robots.txt sitemaps for the store's region only", async () => {
    const fetcher = fakeFetcher(routes);
    expect(await discoverProductUrls(fetcher, "https://brand.example/ie")).toEqual([
      "https://brand.example/ie/product/contour-wand",
      "https://brand.example/ie/product/pillow-talk-lipstick",
    ]);
    expect(fetcher.calls).not.toContain("https://brand.example/uk/sitemap_index.xml");
  });

  it("renders pages whose prices need JavaScript", async () => {
    const fetcher = fakeFetcher({
      ...routes,
      "https://brand.example/ie/product/contour-wand": templatePage("Contour Wand"),
      "https://brand.example/ie/product/pillow-talk-lipstick": templatePage("Pillow Talk Lipstick"),
      "https://brand.example/ie/": "<header>{{banner}}</header>",
    });
    const rendered: string[] = [];
    const renderer: Renderer = {
      async render(url) {
        rendered.push(url);
        if (url.endsWith("/ie/")) return `<div class="announcement-bar">Up to 25% off selected makeup</div>`;
        return url.includes("contour") ? renderedPage("Contour Wand", "€38.00") : renderedPage("Pillow Talk Lipstick", "€35.00");
      },
      async close() {},
    };
    const obs = await collectStore(fetcher, { id: "ct", name: "Brand", url: "https://brand.example/ie", kind: "competitor" }, { renderer });
    expect(obs.source).toBe("structured_data");
    expect(obs.products.map((p) => [p.title, p.priceCents])).toEqual([
      ["Contour Wand", 3800],
      ["Pillow Talk Lipstick", 3500],
    ]);
    expect(obs.promotions.map((p) => p.key)).toEqual(["percent_off:25"]);
    expect(rendered).toHaveLength(3);
  });
});

describe("headless browser", async () => {
  const renderer = await browserRenderer({ timeoutMs: 15_000 });

  it.skipIf(!renderer)("returns the page after its scripts have filled in the price", async () => {
    const server = createServer((_, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<h1>Contour Wand</h1><div class="product-price" id="p">{{price}}</div>
        <script>setTimeout(() => { document.getElementById("p").textContent = "€38.00"; }, 50);</script>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ie/product/contour-wand`;
    try {
      const html = await renderer!.render(url);
      expect(extractStructuredProduct(html, url)).toEqual(expect.objectContaining({ title: "Contour Wand", priceCents: 3800, currency: "EUR" }));
    } finally {
      await renderer!.close();
      server.close();
    }
  }, 30_000);
});

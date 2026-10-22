import * as cheerio from "cheerio";
import { toCents } from "../money.js";
import type { ProductSnapshot } from "../types.js";
import type { Fetcher } from "./http.js";

type JsonObject = Record<string, unknown>;

/**
 * Pulls the schema.org Product that most stores embed for Google Shopping.
 * Works on WooCommerce, BigCommerce, Magento and most custom stores.
 */
export function extractStructuredProduct(html: string, pageUrl: string): ProductSnapshot | null {
  const $ = cheerio.load(html);
  const nodes: JsonObject[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      collectNodes(JSON.parse($(el).text()) as unknown, nodes);
    } catch {
      // Stores ship broken JSON-LD surprisingly often; skip that block.
    }
  });

  const product = nodes.find((n) => hasType(n, "Product") || hasType(n, "ProductGroup"));
  if (!product) return null;

  const offers = flattenOffers(product.offers ?? (product.hasVariant as JsonObject[] | undefined)?.map((v) => v.offers));
  const priced = offers
    .map((o) => ({
      price: toCents(o.price ?? o.lowPrice),
      available: isInStock(o.availability),
      currency: typeof o.priceCurrency === "string" ? o.priceCurrency : undefined,
    }))
    .filter((o): o is { price: number; available: boolean; currency: string | undefined } => o.price !== undefined);
  if (priced.length === 0) return null;

  const inStock = priced.filter((o) => o.available);
  const pool = inStock.length > 0 ? inStock : priced;
  const cheapest = pool.reduce((a, b) => (b.price < a.price ? b : a));

  const sku = typeof product.sku === "string" ? product.sku : undefined;
  const canonical = $('link[rel="canonical"]').attr("href");
  const url = canonical ? new URL(canonical, pageUrl).toString() : pageUrl;

  return {
    externalId: sku ?? url,
    title: String(product.name ?? $("title").text()).trim(),
    url,
    vendor: brandName(product.brand),
    imageUrl: firstImage(product.image),
    currency: cheapest.currency,
    priceCents: cheapest.price,
    available: inStock.length > 0,
  };
}

function collectNodes(value: unknown, out: JsonObject[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectNodes(v, out);
  } else if (value && typeof value === "object") {
    const obj = value as JsonObject;
    out.push(obj);
    if (obj["@graph"]) collectNodes(obj["@graph"], out);
  }
}

function hasType(node: JsonObject, type: string): boolean {
  const t = node["@type"];
  return t === type || (Array.isArray(t) && t.includes(type));
}

function flattenOffers(value: unknown): JsonObject[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenOffers);
  if (typeof value !== "object") return [];
  const obj = value as JsonObject;
  if (hasType(obj, "AggregateOffer") && obj.offers) return [obj, ...flattenOffers(obj.offers)];
  return [obj];
}

function isInStock(availability: unknown): boolean {
  if (typeof availability !== "string") return true;
  return /InStock|LimitedAvailability|PreOrder|OnlineOnly/i.test(availability);
}

function brandName(brand: unknown): string | undefined {
  if (typeof brand === "string") return brand;
  if (brand && typeof brand === "object" && typeof (brand as JsonObject).name === "string") {
    return (brand as JsonObject).name as string;
  }
  return undefined;
}

function firstImage(image: unknown): string | undefined {
  if (typeof image === "string") return image;
  if (Array.isArray(image)) return firstImage(image[0]);
  if (image && typeof image === "object") return firstImage((image as JsonObject).url);
  return undefined;
}

/**
 * Finds product page URLs from the store's sitemap, following nested
 * sitemaps whose name suggests products.
 */
export async function discoverProductUrls(fetcher: Fetcher, origin: string, limit = 500): Promise<string[]> {
  const found = new Set<string>();
  const queue = [`${origin}/sitemap.xml`];
  const seen = new Set<string>();

  while (queue.length > 0 && found.size < limit && seen.size < 20) {
    const sitemapUrl = queue.shift()!;
    if (seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);
    let body: string;
    try {
      const res = await fetcher(sitemapUrl);
      if (res.status !== 200) continue;
      body = res.body;
    } catch {
      continue;
    }
    const $ = cheerio.load(body, { xml: true });
    const nested = $("sitemap > loc").map((_, el) => $(el).text().trim()).get();
    const productSitemaps = nested.filter((loc) => /product/i.test(loc));
    // Follow product sitemaps when the index names them, otherwise all of them.
    queue.push(...(productSitemaps.length > 0 ? productSitemaps : nested));
    const isProductSitemap = /product/i.test(sitemapUrl);
    $("url > loc").each((_, el) => {
      const loc = $(el).text().trim();
      const looksLikeProduct = /\/(products?|p|shop|item)\//i.test(new URL(loc, origin).pathname);
      if (found.size < limit && (isProductSitemap || looksLikeProduct)) found.add(loc);
    });
  }
  return [...found];
}

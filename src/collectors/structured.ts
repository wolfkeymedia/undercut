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
  if (!product) return extractFromMarkup($, pageUrl);

  const offers = flattenOffers(product.offers ?? (product.hasVariant as JsonObject[] | undefined)?.map((v) => v.offers));
  const priced = offers
    .map((o) => ({
      price: toCents(o.price ?? o.lowPrice),
      available: isInStock(o.availability),
      currency: typeof o.priceCurrency === "string" ? o.priceCurrency : undefined,
    }))
    .filter((o): o is { price: number; available: boolean; currency: string | undefined } => o.price !== undefined);
  if (priced.length === 0) return extractFromMarkup($, pageUrl);

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
 * Finds product page URLs from the store's sitemaps. Starts from the sitemaps
 * robots.txt lists, falling back to the usual locations, and follows nested
 * sitemaps (preferring ones named for products). For a regional store such as
 * https://brand.com/ie, keeps to that region's sitemaps and pages.
 */
export async function discoverProductUrls(fetcher: Fetcher, storeUrl: string, limit = 500): Promise<string[]> {
  const base = new URL(storeUrl);
  const origin = base.origin;
  const region = base.pathname.replace(/\/+$/, ""); // "" or e.g. "/ie"
  const regionCode = region.split("/").filter(Boolean).pop();
  const inRegion = (loc: string) =>
    !regionCode || loc.includes(`/${regionCode}/`) || loc.includes(`${regionCode}_`) || loc.includes(`_${regionCode}`) || loc.includes(`-${regionCode}`);

  const queue = await sitemapsFromRobots(fetcher, origin);
  const regional = queue.filter(inRegion);
  if (regional.length > 0) queue.splice(0, queue.length, ...regional);
  if (queue.length === 0) {
    queue.push(...(region ? [`${origin}${region}/sitemap_index.xml`, `${origin}${region}/sitemap.xml`] : []), `${origin}/sitemap_index.xml`, `${origin}/sitemap.xml`);
  }

  const found = new Set<string>();
  const seen = new Set<string>();
  while (queue.length > 0 && found.size < limit && seen.size < 25) {
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
    const scoped = nested.filter(inRegion);
    const candidates = scoped.length > 0 ? scoped : nested;
    const productSitemaps = candidates.filter((loc) => /product/i.test(loc));
    // Follow product sitemaps when the index names them, otherwise all of them.
    queue.push(...(productSitemaps.length > 0 ? productSitemaps : candidates));
    const isProductSitemap = /product/i.test(sitemapUrl);
    $("url > loc").each((_, el) => {
      const loc = $(el).text().trim();
      let path: string;
      try {
        path = new URL(loc, origin).pathname;
      } catch {
        return;
      }
      if (region && !path.startsWith(`${region}/`)) return;
      const looksLikeProduct = /\/(products?|p|shop|item)\//i.test(path);
      if (found.size < limit && (isProductSitemap || looksLikeProduct)) found.add(loc);
    });
  }
  return [...found];
}

async function sitemapsFromRobots(fetcher: Fetcher, origin: string): Promise<string[]> {
  try {
    const res = await fetcher(`${origin}/robots.txt`);
    if (res.status !== 200) return [];
    return res.body
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*sitemap:\s*(\S+)/i)?.[1])
      .filter((u): u is string => Boolean(u));
  } catch {
    return [];
  }
}

const CURRENCY_SYMBOLS: Record<string, string> = { "€": "EUR", "£": "GBP", $: "USD" };
const PRICE_TEXT = /([€£$])\s?(\d{1,5}(?:[.,]\d{3})*(?:[.,]\d{2})?)|(\d{1,5}(?:[.,]\d{2})?)\s?([€£])/;

/**
 * Fallback for pages without JSON-LD: Open Graph product tags, schema.org
 * microdata, then the first visible price in a price-like element. Works on
 * browser-rendered pages too, where prices only appear after scripts run.
 */
export function extractFromMarkup($: cheerio.CheerioAPI, pageUrl: string): ProductSnapshot | null {
  const meta = (name: string) => $(`meta[property="${name}"], meta[name="${name}"]`).attr("content")?.trim();
  const itemprop = (name: string) => {
    const el = $(`[itemprop="${name}"]`).first();
    return (el.attr("content") ?? el.text()).trim() || undefined;
  };

  let priceCents = toCents(meta("product:price:amount") ?? meta("og:price:amount") ?? itemprop("price"));
  let currency = meta("product:price:currency") ?? meta("og:price:currency") ?? itemprop("priceCurrency");
  let compareAtCents: number | undefined;

  if (priceCents === undefined) {
    // Visible price: the first price-like element whose text holds an actual amount (not a {{template}}).
    const candidates = $('[data-price], [class*="price" i], [id*="price" i]')
      .filter((_, el) => !/was|compare|original|strike|old|rrp/i.test(`${$(el).attr("class") ?? ""} ${$(el).attr("id") ?? ""}`))
      .toArray();
    for (const el of candidates) {
      const text = $(el).clone().children("s, del").remove().end().text().replace(/\s+/g, " ");
      if (text.includes("{{")) continue;
      const m = text.match(PRICE_TEXT);
      if (!m) continue;
      priceCents = toCents(m[2] ?? m[3]);
      currency ??= CURRENCY_SYMBOLS[m[1] ?? m[4] ?? ""];
      break;
    }
    const was = $('s, del, [class*="was" i], [class*="compare" i], [class*="original" i], [class*="strike" i]')
      .toArray()
      .map((el) => $(el).text().match(PRICE_TEXT))
      .find(Boolean);
    const wasCents = was ? toCents(was[2] ?? was[3]) : undefined;
    if (wasCents && priceCents && wasCents > priceCents) compareAtCents = wasCents;
  }
  if (priceCents === undefined || priceCents <= 0) return null;

  const title = (meta("og:title") ?? $("h1").first().text() ?? $("title").text()).replace(/\s+/g, " ").trim();
  if (!title) return null;
  const availability = meta("product:availability") ?? meta("og:availability") ?? itemprop("availability");
  const canonical = $('link[rel="canonical"]').attr("href") ?? meta("og:url");
  const url = canonical ? new URL(canonical, pageUrl).toString() : pageUrl;

  return {
    externalId: itemprop("sku") ?? meta("product:retailer_item_id") ?? url,
    title,
    url,
    imageUrl: meta("og:image"),
    currency,
    priceCents,
    compareAtCents,
    available: availability ? !/out.?of.?stock|oos|sold.?out|discontinued/i.test(availability) : true,
  };
}

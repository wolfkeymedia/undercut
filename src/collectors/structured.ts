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

/** Containers that hold other products' prices: upsells, bundles, carousels, menus. */
const OTHER_PRODUCTS =
  '[class*="upsell" i], [class*="bundle" i], [class*="carousel" i], [class*="recommend" i], [class*="related" i], [class*="cross-sell" i], [class*="crosssell" i], [class*="also-like" i], [class*="you-may" i], nav, footer';

/**
 * Fallback for pages without JSON-LD: the page's Next.js data, Open Graph
 * product tags, schema.org microdata, then the first visible price that
 * belongs to the main product (not an upsell or carousel). Works on
 * browser-rendered pages too, where prices only appear after scripts run.
 */
export function extractFromMarkup($: cheerio.CheerioAPI, pageUrl: string): ProductSnapshot | null {
  const meta = (name: string) => $(`meta[property="${name}"], meta[name="${name}"]`).attr("content")?.trim();
  const itemprop = (name: string) => {
    const el = $(`[itemprop="${name}"]`).first();
    return (el.attr("content") ?? el.text()).trim() || undefined;
  };
  const canonical = $('link[rel="canonical"]').attr("href") ?? meta("og:url");
  const url = canonical ? new URL(canonical, pageUrl).toString() : pageUrl;
  const rawTitle = (meta("og:title") ?? $("h1").first().text() ?? $("title").text()).replace(/\s+/g, " ").trim();
  const title = tidyTitle(stripSiteName(rawTitle, meta("og:site_name")));

  const fromNext = extractFromNextData($, url);
  if (fromNext) {
    // The page's own title often carries the shade or size the data leaves out.
    const base = tidyTitle(fromNext.title || title);
    const named = title.toLowerCase().startsWith(base.toLowerCase()) && title.length > base.length ? tidyTitle(title) : base;
    // Drop words the title already has, e.g. "Refill" in "Foundation Refill – Fair-Medium Refill".
    const titleWords = new Set(named.toLowerCase().split(/\s+/));
    const shade = fromNext.variant?.split(/\s+/).filter((w) => !titleWords.has(w.toLowerCase())).join(" ");
    const variant = shade && !named.toLowerCase().includes(shade.toLowerCase()) ? ` – ${shade}` : "";
    const { variant: _v, ...rest } = fromNext;
    return { ...rest, title: (named + variant).replace(/\s+/g, " ").trim(), url, imageUrl: fromNext.imageUrl ?? meta("og:image") };
  }

  let priceCents = toCents(meta("product:price:amount") ?? meta("og:price:amount") ?? itemprop("price"));
  let currency = meta("product:price:currency") ?? meta("og:price:currency") ?? itemprop("priceCurrency");
  let compareAtCents: number | undefined;

  if (priceCents === undefined) {
    // Visible price: the first price element of the main product whose text holds an actual amount (not a {{template}}).
    const candidates = $('[data-price], [data-price-amount], [class*="price" i], [id*="price" i]')
      .filter((_, el) => !/was|compare|original|strike|old|rrp/i.test(`${$(el).attr("class") ?? ""} ${$(el).attr("id") ?? ""}`))
      .filter((_, el) => $(el).closest(OTHER_PRODUCTS).length === 0)
      .toArray();
    for (const el of candidates) {
      const $el = $(el);
      const now = $el.find("ins").first();
      const amount = (now.length ? now : $el).attr("data-price-amount") ?? $el.attr("data-price-amount");
      const text = (now.length ? now : $el.clone().children("s, del").remove().end()).text().replace(/\s+/g, " ");
      if (!amount && text.includes("{{")) continue;
      const m = text.match(PRICE_TEXT);
      const cents = amount ? toCents(amount) : m ? toCents(m[2] ?? m[3]) : undefined;
      if (!cents) continue;
      priceCents = cents;
      currency ??= $el.attr("data-price-currency") ?? CURRENCY_SYMBOLS[m?.[1] ?? m?.[4] ?? ""];
      // A was-price only counts when it sits with this price, not elsewhere on the page.
      const wasEl = $el.find('del, s, [class*="rrp" i], [class*="was" i], [class*="compare" i]').first();
      const wasText = wasEl.attr("data-price-amount") ?? wasEl.text().match(PRICE_TEXT)?.slice(2, 4).find(Boolean);
      const wasCents = wasText ? toCents(wasText) : undefined;
      if (wasCents && wasCents > priceCents) compareAtCents = wasCents;
      break;
    }
  }
  if (priceCents === undefined || priceCents <= 0) return null;
  if (!title) return null;
  const availability = meta("product:availability") ?? meta("og:availability") ?? itemprop("availability");

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

/** "Airbrush Flawless Finish | Charlotte Tilbury" -> "Airbrush Flawless Finish". */
const KEEP_UPPER = new Set(["SPF", "UV", "CC", "BB", "XL", "XS", "XXL", "ML", "UK", "EU", "US", "LED", "PA", "AHA", "BHA"]);
const SMALL_WORDS = new Set(["a", "an", "and", "the", "of", "with", "for", "in", "on", "to", "by", "or", "at", "&"]);

/** Turns an ALL CAPS title into title case; leaves other titles alone. */
export function tidyTitle(title: string): string {
  if (/[a-z]/.test(title) || !/[A-Z]{2}/.test(title)) return title;
  return title
    .split(/(\s+)/)
    .map((word, i) => {
      if (/^\s+$/.test(word) || KEEP_UPPER.has(word.replace(/[^A-Z]/g, "")) || /\d/.test(word)) return word;
      const lower = word.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.replace(/(^|[-–/+(])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
    })
    .join("");
}

export function stripSiteName(title: string, siteName?: string): string {
  let t = title.replace(/\s+\|\s+[^|]+$/, "");
  if (siteName) t = t.replace(new RegExp(`\\s+[-–—]\\s+${siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), "");
  return t.trim() || title;
}

type JsonObject2 = Record<string, unknown>;

/**
 * Next.js storefronts embed their product data as JSON in __NEXT_DATA__.
 * Finds the product whose slug or URL matches the page, so upsell and carousel
 * products on the same page are never mistaken for it.
 */
function extractFromNextData($: cheerio.CheerioAPI, pageUrl: string): (Omit<ProductSnapshot, "url"> & { variant?: string }) | null {
  const raw = $("script#__NEXT_DATA__").text();
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const slug = new URL(pageUrl).pathname.replace(/\/+$/, "").split("/").pop()?.toLowerCase();
  if (!slug) return null;

  const candidates: JsonObject2[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 30 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as JsonObject2;
    const price = o.price as JsonObject2 | undefined;
    if (price && typeof price === "object" && (price.purchasePrice as JsonObject2 | undefined)?.value !== undefined) candidates.push(o);
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(data, 0);

  const matchesPage = (o: JsonObject2) =>
    ["slug", "href", "url", "path", "handle", "productUrl"].some((k) => typeof o[k] === "string" && (o[k] as string).toLowerCase().replace(/\/+$/, "").endsWith(slug));
  const product = candidates.find(matchesPage) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!product) return null;

  const price = product.price as JsonObject2;
  const purchase = price.purchasePrice as JsonObject2;
  const listing = price.listingPrice as JsonObject2 | undefined;
  const priceCents = toCents(purchase.value);
  if (!priceCents) return null;
  const listCents = toCents(listing?.value);
  const stock = product.availability ?? product.inStock ?? product.isAvailable ?? product.available ?? product.stockStatus;
  const available =
    typeof stock === "boolean" ? stock : typeof stock === "string" ? !/out.?of.?stock|oos|sold.?out|unavailable/i.test(stock) : true;
  const name = [product.title, product.name].find((x): x is string => typeof x === "string") ?? "";
  const currency = [purchase.currencyCode, purchase.currency, price.currencyCode].find((x): x is string => typeof x === "string");
  const id = [product.sku, product.id].find((x) => typeof x === "string" || typeof x === "number");
  // Shade or size, when the product object names it separately from the title.
  // A subtitle only names the variant on products that have swatches (e.g. "TAN - DEEP").
  const variantKeys = ["shade", "shadeName", "colour", "color", "variantName", "variantTitle", "size"];
  if (typeof product.swatchVariant === "string" && /shade|colou?r|size/i.test(product.swatchVariant)) variantKeys.push("subtitle");
  const variant = variantKeys
    .map((k) => product[k])
    .map((v) => (v && typeof v === "object" ? ((v as JsonObject2).name ?? (v as JsonObject2).label ?? (v as JsonObject2).value) : v))
    .find((v): v is string => typeof v === "string" && v.trim().length > 0)
    ?.trim();

  return {
    externalId: id !== undefined ? String(id) : pageUrl,
    title: name,
    currency,
    priceCents,
    compareAtCents: listCents && listCents > priceCents ? listCents : undefined,
    available,
    variant: variant ? tidyTitle(variant.replace(/\s+-\s+/g, "-")) : undefined,
    // e.g. "Makeup/Face/Powder"
    productType: typeof product.category === "string" ? product.category.split("/").pop()?.trim() || undefined : undefined,
  };
}

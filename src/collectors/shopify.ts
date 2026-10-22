import { toCents } from "../money.js";
import type { ProductSnapshot } from "../types.js";
import type { Fetcher } from "./http.js";

/** Shape of the public storefront feed every Shopify store serves at /products.json. */
interface ShopifyFeed {
  products: ShopifyProduct[];
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  vendor?: string;
  product_type?: string;
  images?: { src: string }[];
  variants: {
    price: string;
    compare_at_price?: string | null;
    available?: boolean;
  }[];
}

const PAGE_SIZE = 250;

export interface ShopifyFeedOptions {
  /** Stop after this many pages so one huge store can't eat the whole run. */
  maxPages?: number;
}

/**
 * Reads a store's public product feed. Returns null when the store is not on
 * Shopify or has the feed turned off, so the caller can fall back.
 */
export async function collectShopifyFeed(
  fetcher: Fetcher,
  origin: string,
  options: ShopifyFeedOptions = {},
): Promise<ProductSnapshot[] | null> {
  const maxPages = options.maxPages ?? 40;
  const products: ProductSnapshot[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const res = await fetcher(`${origin}/products.json?limit=${PAGE_SIZE}&page=${page}`);
    const feed = res.status === 200 ? parseFeed(res.body) : null;
    if (!feed) {
      if (page === 1) return null;
      break;
    }
    for (const p of feed.products) {
      const snapshot = toSnapshot(origin, p);
      if (snapshot) products.push(snapshot);
    }
    if (feed.products.length < PAGE_SIZE) break;
  }
  return products;
}

function parseFeed(body: string): ShopifyFeed | null {
  try {
    const json = JSON.parse(body) as unknown;
    if (json && typeof json === "object" && Array.isArray((json as ShopifyFeed).products)) {
      return json as ShopifyFeed;
    }
  } catch {
    // Not JSON: the store is not on Shopify, or returned an error page.
  }
  return null;
}

export function toSnapshot(origin: string, p: ShopifyProduct): ProductSnapshot | null {
  const variants = p.variants
    .map((v) => ({ price: toCents(v.price), compareAt: toCents(v.compare_at_price), available: v.available ?? true }))
    .filter((v): v is { price: number; compareAt: number | undefined; available: boolean } => v.price !== undefined);
  if (variants.length === 0) return null;

  const available = variants.filter((v) => v.available);
  const pool = available.length > 0 ? available : variants;
  const cheapest = pool.reduce((a, b) => (b.price < a.price ? b : a));

  return {
    externalId: String(p.id),
    title: p.title,
    url: `${origin}/products/${p.handle}`,
    vendor: p.vendor || undefined,
    productType: p.product_type || undefined,
    imageUrl: p.images?.[0]?.src,
    priceCents: cheapest.price,
    compareAtCents: cheapest.compareAt && cheapest.compareAt > cheapest.price ? cheapest.compareAt : undefined,
    available: available.length > 0,
  };
}

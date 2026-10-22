import type { ProductSnapshot, Store, StoreObservation } from "../types.js";
import type { Fetcher } from "./http.js";
import { detectPromotions } from "./promotions.js";
import { collectShopifyFeed } from "./shopify.js";
import { discoverProductUrls, extractStructuredProduct } from "./structured.js";

export interface CollectOptions {
  /** Product pages to read on stores without a Shopify feed. Each page is one request. */
  maxProductPages?: number;
  /** Extra product URLs to always check, e.g. ones the merchant added by hand. */
  productUrls?: string[];
}

/**
 * Collects one store's products and promotions. Tries the Shopify feed first
 * because it is one request per 250 products; falls back to reading product
 * pages found in the sitemap.
 */
export async function collectStore(fetcher: Fetcher, store: Store, options: CollectOptions = {}): Promise<StoreObservation> {
  const origin = new URL(store.url).origin;
  const observedAt = new Date();

  let products = await collectShopifyFeed(fetcher, origin);
  let source: StoreObservation["source"] = "shopify_feed";

  if (products === null) {
    source = "structured_data";
    const discovered = await discoverProductUrls(fetcher, origin, options.maxProductPages ?? 200);
    const urls = [...new Set([...(options.productUrls ?? []), ...discovered])].slice(0, options.maxProductPages ?? 200);
    products = await collectProductPages(fetcher, urls);
  } else if (options.productUrls?.length) {
    const known = new Set(products.map((p) => p.url));
    const extra = await collectProductPages(fetcher, options.productUrls.filter((u) => !known.has(u)));
    if (extra.length > 0) source = "mixed";
    products.push(...extra);
  }

  let promotions: StoreObservation["promotions"] = [];
  try {
    const home = await fetcher(`${origin}/`);
    if (home.status === 200) promotions = detectPromotions(home.body);
  } catch {
    // A failed homepage read only loses promo data for this run.
  }

  return { storeId: store.id, observedAt, products: dedupe(products), promotions, source };
}

async function collectProductPages(fetcher: Fetcher, urls: string[]): Promise<ProductSnapshot[]> {
  const out: ProductSnapshot[] = [];
  for (const url of urls) {
    try {
      const res = await fetcher(url);
      if (res.status !== 200) continue;
      const product = extractStructuredProduct(res.body, url);
      if (product) out.push(product);
    } catch {
      // Skip pages that time out or are blocked; the next run retries them.
    }
  }
  return out;
}

function dedupe(products: ProductSnapshot[]): ProductSnapshot[] {
  const byId = new Map<string, ProductSnapshot>();
  for (const p of products) byId.set(p.externalId, p);
  return [...byId.values()];
}

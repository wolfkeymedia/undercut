import type { ProductSnapshot, Store, StoreObservation } from "../types.js";
import type { Fetcher } from "./http.js";
import { detectPromotions } from "./promotions.js";
import type { Renderer } from "./render.js";
import { collectShopifyFeed, shopifyCurrency } from "./shopify.js";
import { discoverProductUrls, extractStructuredProduct } from "./structured.js";

export interface CollectOptions {
  /** Product pages to read on stores without a Shopify feed. Each page is one request. */
  maxProductPages?: number;
  /** Extra product URLs to always check, e.g. ones the merchant added by hand. */
  productUrls?: string[];
  /** Headless browser for pages whose prices only appear after JavaScript runs. */
  renderer?: Renderer | null;
}

/**
 * Collects one store's products and promotions. Tries the Shopify feed first
 * because it is one request per 250 products; falls back to reading product
 * pages found in the sitemap.
 */
export async function collectStore(fetcher: Fetcher, store: Store, options: CollectOptions = {}): Promise<StoreObservation> {
  // A store can be a regional part of a site, e.g. https://brand.com/ie.
  const base = store.url.replace(/\/+$/, "");
  const observedAt = new Date();
  const renderer = options.renderer ?? null;

  let products = await collectShopifyFeed(fetcher, base);
  let source: StoreObservation["source"] = "shopify_feed";

  if (products === null) {
    source = "structured_data";
    const discovered = await discoverProductUrls(fetcher, base, options.maxProductPages ?? 200);
    const urls = [...new Set([...(options.productUrls ?? []), ...discovered])].slice(0, options.maxProductPages ?? 200);
    products = await collectProductPages(fetcher, urls, renderer);
  } else if (options.productUrls?.length) {
    const known = new Set(products.map((p) => p.url));
    const extra = await collectProductPages(fetcher, options.productUrls.filter((u) => !known.has(u)), renderer);
    if (extra.length > 0) source = "mixed";
    products.push(...extra);
  }

  let promotions: StoreObservation["promotions"] = [];
  try {
    const home = await fetcher(`${base}/`);
    if (home.status === 200) promotions = detectPromotions(home.body);
    const currency = source !== "structured_data" && home.status === 200 ? shopifyCurrency(home.body) : undefined;
    if (currency) products = products.map((p) => (p.currency ? p : { ...p, currency }));
    // Sale banners are often injected by scripts too.
    if (home.status === 200 && promotions.length === 0 && renderer) promotions = detectPromotions(await renderer.render(`${base}/`));
  } catch {
    // A failed homepage read only loses promo data for this run.
  }

  return { storeId: store.id, observedAt, products: dedupe(products), promotions, source };
}

export async function collectProductPages(fetcher: Fetcher, urls: string[], renderer: Renderer | null = null): Promise<ProductSnapshot[]> {
  const out: ProductSnapshot[] = [];
  for (const url of urls) {
    try {
      // The plain fetch also checks robots.txt and spaces requests, so a page is only rendered if it may be read.
      const res = await fetcher(url);
      if (res.status !== 200) continue;
      let product = extractStructuredProduct(res.body, url);
      if (!product && renderer) product = extractStructuredProduct(await renderer.render(url), url);
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

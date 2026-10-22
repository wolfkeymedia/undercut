import type { Fetcher, FetchResult } from "../src/collectors/http.js";

/** A fetcher serving fixed responses by URL; anything else is a 404. */
export function fakeFetcher(routes: Record<string, string | (() => string)>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string): Promise<FetchResult> => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) return { status: 404, body: "Not found", contentType: "text/html" };
    const body = typeof route === "function" ? route() : route;
    return { status: 200, body, contentType: body.trim().startsWith("{") ? "application/json" : "text/html" };
  }) as Fetcher & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export function shopifyFeed(products: { id: number; title: string; price: string; available?: boolean; compareAt?: string; type?: string }[]): string {
  return JSON.stringify({
    products: products.map((p) => ({
      id: p.id,
      title: p.title,
      handle: p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      vendor: "Test",
      product_type: p.type ?? "Coffee",
      images: [],
      variants: [{ price: p.price, compare_at_price: p.compareAt ?? null, available: p.available ?? true }],
    })),
  });
}

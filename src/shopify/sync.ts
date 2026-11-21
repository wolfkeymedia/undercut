import { toCents } from "../money.js";
import type { ProductEconomics } from "../types.js";
import { SHOPIFY_API_VERSION } from "./oauth.js";

/**
 * With a client's read-only install, fills in what the public storefront can't show:
 * each product's unit cost (for margins) and its recent weekly unit sales (for the
 * money-at-stake figures). Keys match the product ids the storefront feed uses.
 */

export type GraphQL = (query: string, variables?: Record<string, unknown>) => Promise<any>;

export function adminGraphQL(shop: string, accessToken: string, fetchImpl: typeof fetch = fetch): GraphQL {
  return async (query, variables = {}) => {
    const res = await fetchImpl(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": accessToken },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`Shopify refused access to ${shop} (HTTP ${res.status}); the app may have been uninstalled`);
    if (!res.ok) throw new Error(`Shopify Admin API returned HTTP ${res.status}`);
    const body = (await res.json()) as { data?: any; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`Shopify Admin API: ${body.errors.map((e) => e.message).join("; ")}`);
    return body.data;
  };
}

const PRODUCTS = `query Products($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id variants(first: 50) { nodes { price inventoryItem { unitCost { amount } } } } }
  }
}`;

const ORDERS = `query Orders($cursor: String, $query: String) {
  orders(first: 100, after: $cursor, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes { cancelledAt lineItems(first: 100) { nodes { quantity product { id } } } }
  }
}`;

const numericId = (gid: string) => gid.split("/").pop() ?? gid;

export async function shopInfo(gql: GraphQL): Promise<{ name: string; url: string; currency: string }> {
  const data = await gql(`{ shop { name currencyCode primaryDomain { url } } }`);
  return { name: data.shop.name, url: data.shop.primaryDomain.url, currency: data.shop.currencyCode };
}

export async function fetchEconomics(
  gql: GraphQL,
  options: { days?: number; now?: Date; maxPages?: number } = {},
): Promise<Map<string, ProductEconomics>> {
  const days = options.days ?? 28;
  const maxPages = options.maxPages ?? 50;
  const out = new Map<string, ProductEconomics>();

  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data: any = await gql(PRODUCTS, { cursor });
    for (const p of data.products.nodes) {
      // The storefront shows the cheapest variant, so take that variant's cost.
      const variants = (p.variants.nodes as any[])
        .map((v) => ({ price: toCents(v.price), cost: toCents(v.inventoryItem?.unitCost?.amount) }))
        .filter((v) => v.price !== undefined && v.price > 0);
      const cheapest = variants.sort((a, b) => a.price! - b.price!)[0];
      if (cheapest?.cost !== undefined) out.set(numericId(p.id), { costCents: cheapest.cost });
    }
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }

  const since = new Date((options.now ?? new Date()).getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const units = new Map<string, number>();
  cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const data: any = await gql(ORDERS, { cursor, query: `created_at:>=${since}` });
    for (const o of data.orders.nodes) {
      if (o.cancelledAt) continue;
      for (const li of o.lineItems.nodes) {
        if (!li.product?.id) continue;
        const id = numericId(li.product.id);
        units.set(id, (units.get(id) ?? 0) + li.quantity);
      }
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
  }
  for (const [id, qty] of units) {
    out.set(id, { ...out.get(id), unitsPerWeek: Math.round((qty / (days / 7)) * 10) / 10 });
  }
  return out;
}

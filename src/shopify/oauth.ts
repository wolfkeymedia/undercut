import { createHmac } from "node:crypto";
import { safeEqual } from "../web/secrets.js";

/**
 * Shopify's standard OAuth install flow for a read-only app:
 * 1. send the merchant to https://{shop}/admin/oauth/authorize with our key, scopes and a one-time state;
 * 2. Shopify redirects back with code, shop, state, timestamp and an HMAC of those parameters;
 * 3. check the HMAC, the state and the shop name, then swap the code for an offline access token.
 * https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 */

/** Read-only: products and costs for margins, orders for weekly sales. Nothing that can change the store. */
export const SHOPIFY_SCOPES = ["read_products", "read_inventory", "read_orders"] as const;

export const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";

export interface ShopifyAppCredentials {
  apiKey: string;
  apiSecret: string;
}

/** Accepts "brand", "brand.myshopify.com" or an admin URL; returns "brand.myshopify.com", or null if it isn't a valid shop. */
export function normaliseShop(input: string | undefined | null): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (/^[a-z0-9][a-z0-9-]*$/.test(s)) s = `${s}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null;
}

export function authorizeUrl(shop: string, creds: ShopifyAppCredentials, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: creds.apiKey, scope: SHOPIFY_SCOPES.join(","), redirect_uri: redirectUri, state });
  return `https://${shop}/admin/oauth/authorize?${q}`;
}

/** Checks the hmac Shopify adds to every redirect and app URL query string. */
export function verifyQueryHmac(query: URLSearchParams, apiSecret: string): boolean {
  const hmac = query.get("hmac");
  if (!hmac) return false;
  const message = [...query.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = createHmac("sha256", apiSecret).update(message).digest("hex");
  return safeEqual(digest, hmac.toLowerCase());
}

/** Checks the X-Shopify-Hmac-Sha256 header of a webhook against its raw body. */
export function verifyWebhookHmac(rawBody: Buffer | string, header: string | undefined, apiSecret: string): boolean {
  if (!header) return false;
  const digest = createHmac("sha256", apiSecret).update(rawBody).digest("base64");
  return safeEqual(digest, header);
}

export type HttpPost = (url: string, body: unknown) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

const defaultPost: HttpPost = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

/** Swaps the one-time code for an offline access token. Refuses a token missing any read scope we asked for. */
export async function exchangeCode(
  shop: string,
  code: string,
  creds: ShopifyAppCredentials,
  post: HttpPost = defaultPost,
): Promise<{ accessToken: string; scopes: string }> {
  const res = await post(`https://${shop}/admin/oauth/access_token`, { client_id: creds.apiKey, client_secret: creds.apiSecret, code });
  if (!res.ok) throw new Error(`Shopify refused the install code (HTTP ${res.status})`);
  const data = (await res.json()) as { access_token?: string; scope?: string };
  if (!data.access_token) throw new Error("Shopify did not return an access token");
  const granted = new Set((data.scope ?? "").split(",").map((s) => s.trim()));
  // read_products is implied by write_products; we never ask for write, so expect the read scopes.
  const missing = SHOPIFY_SCOPES.filter((s) => !granted.has(s) && !granted.has(s.replace("read_", "write_")));
  if (missing.length > 0) throw new Error(`The install is missing access we need: ${missing.join(", ")}`);
  return { accessToken: data.access_token, scopes: data.scope ?? "" };
}

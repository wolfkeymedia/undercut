import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/web/app.js";
import { fakeFetcher, shopifyFeed } from "./helpers.js";

// Runs only with a disposable database, like the Postgres tests; uses its own database next to it.
const baseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!baseUrl)("hosted app", () => {
  const env = {
    DATABASE_URL: "",
    UNDERCUT_SECRET: "test-secret-that-is-long-enough-1234",
    ADMIN_PASSWORD: "letmein",
    CRON_SECRET: "cron-secret",
    SHOPIFY_API_KEY: "key123",
    SHOPIFY_API_SECRET: "shh",
  };
  let server: Server;
  let origin = "";
  let adminCookie = "";
  const pending: Promise<unknown>[] = [];
  const settle = async () => {
    while (pending.length) await pending.shift();
  };
  const fetcher = fakeFetcher({
    "https://mine.example/products.json?limit=250&page=1": shopifyFeed([{ id: 10, title: "Glow Serum 30ml", price: "30.00" }]),
    "https://them.example/products.json?limit=250&page=1": shopifyFeed([{ id: 1, title: "Glow Serum 30 ml", price: "27.00" }]),
  });

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: baseUrl });
    await admin.query("DROP DATABASE IF EXISTS undercut_web_test WITH (FORCE)");
    await admin.query("CREATE DATABASE undercut_web_test");
    await admin.end();
    const u = new URL(baseUrl!);
    u.pathname = "/undercut_web_test";
    env.DATABASE_URL = u.toString();
    server = createServer(createApp(env, { background: (p) => void pending.push(p), fetcher }));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await settle();
    server?.close();
  });

  const post = (path: string, form: Record<string, string>, cookie = adminCookie) =>
    fetch(`${origin}${path}`, { method: "POST", body: new URLSearchParams(form), headers: { cookie }, redirect: "manual" });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, { headers: { cookie: adminCookie, ...headers }, redirect: "manual" });

  it("asks for the admin password", async () => {
    expect((await get("/", { cookie: "" })).headers.get("location")).toBe("/login");
    expect((await post("/login", { password: "nope" }, "")).status).toBe(401);
    const ok = await post("/login", { password: "letmein" }, "");
    expect(ok.status).toBe(303);
    adminCookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    expect((await get("/")).status).toBe(200);
  });

  it("refuses scheduled jobs without the cron secret", async () => {
    expect((await get("/api/cron/collect")).status).toBe(401);
  });

  it("adds a client, checks its stores and serves its report link", async () => {
    const res = await post("/clients", { name: "Glow Co", store: "mine.example", competitors: "https://them.example\n" });
    expect(res.headers.get("location")).toMatch(/^\/clients\/glow-co\?ok=/);
    await settle();

    const page = await (await get("/clients/glow-co")).text();
    expect(page).toContain("them.example");
    expect(page).toContain("Glow Serum 30 ml");
    const link = page.match(/\/r\/([a-f0-9]{32})/)![0];

    // Confirm the suggested pair, then the weekly report is the one shown.
    const key = page.match(/name="key" value="([^"]+)"/)![1]!.replace(/&quot;/g, '"');
    await post("/clients/glow-co/matches", { key, status: "confirmed" });
    const report = await (await fetch(`${origin}${link}`)).text();
    expect(report).toContain("Undercut weekly report");
    expect(report).toContain("Market view");
    expect((await fetch(`${origin}${link}/market`)).status).toBe(200);
    expect((await fetch(`${origin}/r/${"0".repeat(32)}`)).status).toBe(404);
  });

  it("keeps clients apart while sharing a competitor", async () => {
    await post("/clients", { name: "Other Brand", competitors: "https://them.example" });
    await settle();
    const other = await (await get("/clients/other-brand")).text();
    expect(other).toContain("them.example");
    expect(other).not.toContain("Glow Serum 30ml"); // Glow Co's own product
    expect(other).toContain("No confirmed pairs yet");
  });

  it("runs the daily collection through the cron endpoint", async () => {
    const res = await get("/api/cron/collect", { authorization: "Bearer cron-secret" });
    expect(await res.json()).toEqual({ dispatched: 2, failed: 0 });
    await settle();
    const finish = await (await get("/api/cron/finish", { authorization: "Bearer cron-secret" })).json();
    expect(finish.clients.map((c: { clientId: string }) => c.clientId)).toEqual(["glow-co", "other-brand"]);
  });

  it("installs the Shopify app with checked signatures and state", async () => {
    const start = await get("/shopify/install?client=glow-co&shop=glow");
    const location = new URL(start.headers.get("location")!);
    expect(location.origin).toBe("https://glow.myshopify.com");
    expect(location.searchParams.get("scope")).toBe("read_products,read_inventory,read_orders");
    expect(location.searchParams.get("redirect_uri")).toBe(`${origin}/shopify/callback`);
    const state = location.searchParams.get("state")!;
    const stateCookie = start.headers.get("set-cookie")!.split(";")[0]!;

    const params = new URLSearchParams({ code: "abc", shop: "glow.myshopify.com", state, timestamp: "1" });
    const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
    params.set("hmac", createHmac("sha256", "shh").update(sorted).digest("hex"));

    const forged = new URLSearchParams(params);
    forged.set("shop", "evil.myshopify.com");
    expect((await get(`/shopify/callback?${forged}`, { cookie: `${adminCookie}; ${stateCookie}` })).status).toBe(401);

    const realFetch = globalThis.fetch;
    const shopify = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === "https://glow.myshopify.com/admin/oauth/access_token") {
        expect(JSON.parse(String(init!.body))).toEqual({ client_id: "key123", client_secret: "shh", code: "abc" });
        return new Response(JSON.stringify({ access_token: "shpat_x", scope: "read_products,read_inventory,read_orders" }));
      }
      if (u.includes("/admin/api/")) {
        const q = String(JSON.parse(String(init!.body)).query);
        const data = q.includes("products(")
          ? { products: { pageInfo: { hasNextPage: false }, nodes: [{ id: "gid://shopify/Product/10", variants: { nodes: [{ price: "30.00", inventoryItem: { unitCost: { amount: "9.50" } } }] } }] } }
          : { orders: { pageInfo: { hasNextPage: false }, nodes: [{ cancelledAt: null, lineItems: { nodes: [{ quantity: 8, product: { id: "gid://shopify/Product/10" } }] } }] } };
        return new Response(JSON.stringify({ data }));
      }
      return realFetch(url as string, init);
    });
    vi.stubGlobal("fetch", shopify);
    try {
      const done = await get(`/shopify/callback?${params}`, { cookie: `${adminCookie}; ${stateCookie}` });
      expect(done.headers.get("location")).toContain("/clients/glow-co?ok=");
      expect(decodeURIComponent(done.headers.get("location")!)).toContain("Synced costs and sales for 1 products");
    } finally {
      vi.unstubAllGlobals();
    }
    const page = await (await get("/clients/glow-co")).text();
    expect(page).toContain("connected");
    expect(page).not.toContain("shpat_x");
  });
});

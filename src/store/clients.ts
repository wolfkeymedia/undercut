import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Config } from "../config.js";

/** One business using Undercut: its own store, competitors, pairs and settings. */
export interface Client {
  id: string;
  name: string;
  /** Secret part of the client's report link. */
  reportToken: string;
  /** Overrides of the default settings. Anything left out uses the defaults. */
  settings: ClientSettings;
  active: boolean;
  shopify?: { shop: string; scopes?: string; installedAt?: Date; syncedAt?: Date; hasToken: boolean };
  createdAt: Date;
}

export type ClientSettings = {
  pricing?: Partial<Config["pricing"]>;
  alerts?: Partial<Config["alerts"]>;
  priceSensitivity?: number;
  maxShareAtRisk?: number;
};

/** A store to collect, with every client that watches it. */
export interface StoreToCheck {
  id: string;
  name: string;
  url: string;
  clientIds: string[];
  lastCheckedAt?: Date;
}

/** Turns a business name into a short id for URLs and the CLI, e.g. "SOSU Cosmetics" -> "sosu-cosmetics". */
export function clientIdFromName(name: string): string {
  const id = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return id || `client-${randomBytes(3).toString("hex")}`;
}

/** The list of clients. Not scoped to a client, so only admin pages and scheduled jobs use it. */
export class ClientRegistry {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<Client[]> {
    const { rows } = await this.pool.query("SELECT * FROM clients ORDER BY created_at");
    return rows.map(rowToClient);
  }

  async get(id: string): Promise<Client | null> {
    const { rows } = await this.pool.query("SELECT * FROM clients WHERE id = $1", [id]);
    return rows[0] ? rowToClient(rows[0]) : null;
  }

  async byReportToken(token: string): Promise<Client | null> {
    if (!/^[a-f0-9]{16,64}$/.test(token)) return null;
    const { rows } = await this.pool.query("SELECT * FROM clients WHERE report_token = $1 AND active", [token]);
    return rows[0] ? rowToClient(rows[0]) : null;
  }

  async byShopifyShop(shop: string): Promise<Client | null> {
    const { rows } = await this.pool.query("SELECT * FROM clients WHERE shopify_shop = $1", [shop]);
    return rows[0] ? rowToClient(rows[0]) : null;
  }

  /** Adds a client, picking a free id from its name when none is given. */
  async create(name: string, id = clientIdFromName(name)): Promise<Client> {
    let candidate = id;
    for (let n = 2; await this.get(candidate); n++) candidate = `${id}-${n}`;
    await this.pool.query("INSERT INTO clients (id, name, report_token) VALUES ($1, $2, $3)", [candidate, name.trim(), newToken()]);
    return (await this.get(candidate))!;
  }

  /** Creates the client if it doesn't exist yet. */
  async ensure(id: string, name: string): Promise<void> {
    await this.pool.query("INSERT INTO clients (id, name, report_token) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [id, name, newToken()]);
  }

  async update(id: string, changes: { name?: string; active?: boolean; settings?: ClientSettings }): Promise<void> {
    await this.pool.query(
      `UPDATE clients SET name = COALESCE($2, name), active = COALESCE($3, active), settings = COALESCE($4, settings) WHERE id = $1`,
      [id, changes.name?.trim() || null, changes.active ?? null, changes.settings ? JSON.stringify(changes.settings) : null],
    );
  }

  /** A new report link; the old one stops working. */
  async rotateReportToken(id: string): Promise<void> {
    await this.pool.query("UPDATE clients SET report_token = $2 WHERE id = $1", [id, newToken()]);
  }

  async remove(id: string): Promise<void> {
    await this.pool.query("DELETE FROM clients WHERE id = $1", [id]);
  }

  async saveShopifyInstall(id: string, install: { shop: string; tokenEnc: string; scopes: string }): Promise<void> {
    // A shop belongs to one client at a time.
    await this.pool.query(
      "UPDATE clients SET shopify_shop = NULL, shopify_token_enc = NULL, shopify_scopes = NULL WHERE shopify_shop = $1 AND id <> $2",
      [install.shop, id],
    );
    await this.pool.query(
      "UPDATE clients SET shopify_shop = $2, shopify_token_enc = $3, shopify_scopes = $4, shopify_installed_at = now() WHERE id = $1",
      [id, install.shop, install.tokenEnc, install.scopes],
    );
  }

  async shopifyToken(id: string): Promise<{ shop: string; tokenEnc: string } | null> {
    const { rows } = await this.pool.query("SELECT shopify_shop, shopify_token_enc FROM clients WHERE id = $1", [id]);
    const r = rows[0];
    return r?.shopify_shop && r.shopify_token_enc ? { shop: r.shopify_shop, tokenEnc: r.shopify_token_enc } : null;
  }

  async markShopifySynced(id: string): Promise<void> {
    await this.pool.query("UPDATE clients SET shopify_synced_at = now() WHERE id = $1", [id]);
  }

  /** The shop uninstalled the app or asked for its data to go: forget the token. */
  async forgetShopify(shop: string): Promise<void> {
    await this.pool.query("UPDATE clients SET shopify_token_enc = NULL, shopify_scopes = NULL WHERE shopify_shop = $1", [shop]);
  }

  /** Every store any active client watches, once each, least recently checked first. */
  async storesToCheck(): Promise<StoreToCheck[]> {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.name, s.url, s.last_checked_at, array_agg(DISTINCT cs.client_id ORDER BY cs.client_id) AS client_ids
       FROM stores s JOIN client_stores cs ON cs.store_id = s.id JOIN clients c ON c.id = cs.client_id AND c.active
       GROUP BY s.id ORDER BY s.last_checked_at NULLS FIRST`,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, url: r.url, clientIds: r.client_ids, lastCheckedAt: r.last_checked_at ?? undefined }));
  }

  async storeStatus(storeIds: string[]): Promise<Map<string, { lastCheckedAt?: Date; lastError?: string; products: number }>> {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.last_checked_at, s.last_error,
              (SELECT count(*)::int FROM product_observations po WHERE po.observation_id =
                 (SELECT id FROM store_observations o WHERE o.store_id = s.id ORDER BY observed_at DESC, id DESC LIMIT 1)) AS products
       FROM stores s WHERE s.id = ANY($1)`,
      [storeIds],
    );
    return new Map(rows.map((r) => [r.id, { lastCheckedAt: r.last_checked_at ?? undefined, lastError: r.last_error ?? undefined, products: r.products }]));
  }

  async recordCheck(storeId: string, error?: string): Promise<void> {
    await this.pool.query("UPDATE stores SET last_checked_at = now(), last_error = $2 WHERE id = $1", [storeId, error ?? null]);
  }
}

function newToken(): string {
  return randomBytes(16).toString("hex");
}

function rowToClient(r: Record<string, any>): Client {
  return {
    id: r.id,
    name: r.name,
    reportToken: r.report_token,
    settings: r.settings ?? {},
    active: r.active,
    shopify: r.shopify_shop
      ? {
          shop: r.shopify_shop,
          scopes: r.shopify_scopes ?? undefined,
          installedAt: r.shopify_installed_at ?? undefined,
          syncedAt: r.shopify_synced_at ?? undefined,
          hasToken: Boolean(r.shopify_token_enc),
        }
      : undefined,
    createdAt: r.created_at,
  };
}

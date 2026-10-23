import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { ChangeEvent, ProductEconomics, ProductMatch, ProductSnapshot, Promotion, Store, StoreObservation } from "../types.js";
import type { Repository } from "./repository.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations");

/** Applies any .sql file in db/migrations that has not run yet, in name order. */
export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await pool.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}

export class PostgresRepository implements Repository {
  constructor(private readonly pool: pg.Pool) {}

  static fromUrl(connectionString: string): PostgresRepository {
    return new PostgresRepository(new pg.Pool({ connectionString }));
  }

  get db(): pg.Pool {
    return this.pool;
  }

  async upsertStore(store: Store) {
    await this.pool.query(
      `INSERT INTO stores (id, name, url, kind) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, kind = EXCLUDED.kind`,
      [store.id, store.name, store.url, store.kind],
    );
  }

  async getStore(id: string) {
    const { rows } = await this.pool.query<Store>("SELECT id, name, url, kind FROM stores WHERE id = $1", [id]);
    return rows[0] ?? null;
  }

  async listStores(kind?: Store["kind"]) {
    const { rows } = await this.pool.query<Store>(
      "SELECT id, name, url, kind FROM stores WHERE $1::text IS NULL OR kind = $1 ORDER BY created_at",
      [kind ?? null],
    );
    return rows;
  }

  async saveObservation(o: StoreObservation) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        "INSERT INTO store_observations (store_id, observed_at, source, promotions) VALUES ($1, $2, $3, $4) RETURNING id",
        [o.storeId, o.observedAt, o.source, JSON.stringify(o.promotions)],
      );
      const observationId = rows[0]!.id;
      if (o.products.length > 0) {
        const col = <K extends keyof ProductSnapshot>(k: K) => o.products.map((p) => p[k] ?? null);
        await client.query(
          `INSERT INTO product_observations
             (observation_id, store_id, observed_at, external_id, title, url, vendor, product_type,
              image_url, currency, price_cents, compare_at_cents, available)
           SELECT $1, $2, $3, * FROM unnest(
             $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
             $9::text[], $10::text[], $11::int[], $12::int[], $13::bool[])`,
          [
            observationId, o.storeId, o.observedAt,
            col("externalId"), col("title"), col("url"), col("vendor"), col("productType"),
            col("imageUrl"), col("currency"), col("priceCents"), col("compareAtCents"), col("available"),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async latestObservation(storeId: string): Promise<StoreObservation | null> {
    const head = await this.pool.query<{ id: string; observed_at: Date; source: StoreObservation["source"]; promotions: Promotion[] }>(
      "SELECT id, observed_at, source, promotions FROM store_observations WHERE store_id = $1 ORDER BY observed_at DESC, id DESC LIMIT 1",
      [storeId],
    );
    const row = head.rows[0];
    if (!row) return null;
    const products = await this.pool.query("SELECT * FROM product_observations WHERE observation_id = $1", [row.id]);
    return {
      storeId,
      observedAt: row.observed_at,
      source: row.source,
      promotions: row.promotions,
      products: products.rows.map(rowToSnapshot),
    };
  }

  async setEconomics(storeId: string, economics: Map<string, ProductEconomics>) {
    if (economics.size === 0) return;
    const rows = [...economics.entries()];
    await this.pool.query(
      `INSERT INTO product_costs (store_id, external_id, cost_cents, units_per_week)
       SELECT $1, * FROM unnest($2::text[], $3::int[], $4::real[])
       ON CONFLICT (store_id, external_id) DO UPDATE SET
         cost_cents = COALESCE(EXCLUDED.cost_cents, product_costs.cost_cents),
         units_per_week = COALESCE(EXCLUDED.units_per_week, product_costs.units_per_week),
         updated_at = now()`,
      [storeId, rows.map(([id]) => id), rows.map(([, e]) => e.costCents ?? null), rows.map(([, e]) => e.unitsPerWeek ?? null)],
    );
  }

  async currentProducts(storeId: string) {
    const latest = await this.latestObservation(storeId);
    if (!latest) return [];
    const { rows } = await this.pool.query<{ external_id: string; cost_cents: number | null; units_per_week: number | null }>(
      "SELECT external_id, cost_cents, units_per_week FROM product_costs WHERE store_id = $1",
      [storeId],
    );
    const economics = new Map(rows.map((r) => [r.external_id, r]));
    return latest.products.map((p) => {
      const e = economics.get(p.externalId);
      return { ...p, costCents: e?.cost_cents ?? undefined, unitsPerWeek: e?.units_per_week ?? undefined };
    });
  }

  async saveEvents(events: ChangeEvent[]) {
    for (const e of events) {
      await this.pool.query(
        `INSERT INTO change_events (store_id, kind, occurred_at, external_id, promo_key, title, url, before_cents, after_cents, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [e.storeId, e.kind, e.occurredAt, e.externalId ?? null, e.promoKey ?? null, e.title, e.url ?? null,
          e.beforeCents ?? null, e.afterCents ?? null, e.detail ?? null],
      );
    }
  }

  async listEvents(since: Date, until = new Date()) {
    const { rows } = await this.pool.query(
      "SELECT * FROM change_events WHERE occurred_at >= $1 AND occurred_at <= $2 ORDER BY occurred_at",
      [since, until],
    );
    return rows.map(
      (r): ChangeEvent => ({
        storeId: r.store_id,
        kind: r.kind,
        occurredAt: r.occurred_at,
        externalId: r.external_id ?? undefined,
        promoKey: r.promo_key ?? undefined,
        title: r.title,
        url: r.url ?? undefined,
        beforeCents: r.before_cents ?? undefined,
        afterCents: r.after_cents ?? undefined,
        detail: r.detail ?? undefined,
      }),
    );
  }

  async saveSuggestedMatches(matches: ProductMatch[]) {
    for (const m of matches) {
      // Never overwrite a decision the merchant already made.
      await this.pool.query(
        `INSERT INTO product_matches (merchant_external_id, competitor_store_id, competitor_external_id, confidence, status)
         VALUES ($1, $2, $3, $4, 'suggested')
         ON CONFLICT (merchant_external_id, competitor_store_id, competitor_external_id)
         DO UPDATE SET confidence = EXCLUDED.confidence, updated_at = now() WHERE product_matches.status = 'suggested'`,
        [m.merchantExternalId, m.competitorStoreId, m.competitorExternalId, m.confidence],
      );
    }
  }

  async listMatches(status?: ProductMatch["status"]) {
    const { rows } = await this.pool.query(
      "SELECT * FROM product_matches WHERE $1::text IS NULL OR status = $1 ORDER BY confidence DESC",
      [status ?? null],
    );
    return rows.map(
      (r): ProductMatch => ({
        merchantExternalId: r.merchant_external_id,
        competitorStoreId: r.competitor_store_id,
        competitorExternalId: r.competitor_external_id,
        confidence: r.confidence,
        status: r.status,
      }),
    );
  }

  async setMatchStatus(key: Parameters<Repository["setMatchStatus"]>[0], status: ProductMatch["status"]) {
    await this.pool.query(
      `UPDATE product_matches SET status = $4, updated_at = now()
       WHERE merchant_external_id = $1 AND competitor_store_id = $2 AND competitor_external_id = $3`,
      [key.merchantExternalId, key.competitorStoreId, key.competitorExternalId, status],
    );
  }

  async close() {
    await this.pool.end();
  }
}

function rowToSnapshot(r: Record<string, any>): ProductSnapshot {
  return {
    externalId: r.external_id,
    title: r.title,
    url: r.url,
    vendor: r.vendor ?? undefined,
    productType: r.product_type ?? undefined,
    imageUrl: r.image_url ?? undefined,
    currency: r.currency ?? undefined,
    priceCents: r.price_cents,
    compareAtCents: r.compare_at_cents ?? undefined,
    available: r.available,
  };
}

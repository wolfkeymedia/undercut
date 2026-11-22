import type pg from "pg";
import type { SiteHealthData } from "../health/check.js";

/** Saved site health checks, one row per run. */
export class SiteHealthStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Starts a run unless one began in the last `staleAfterMs` and hasn't finished. Returns its id, or null when one is already running. */
  async start(clientId: string, site: string, staleAfterMs = 15 * 60_000): Promise<number | null> {
    const { rows } = await this.pool.query(
      `INSERT INTO site_health_checks (client_id, site)
       SELECT $1, $2 WHERE NOT EXISTS (
         SELECT 1 FROM site_health_checks WHERE client_id = $1 AND finished_at IS NULL AND started_at > now() - ($3::int * interval '1 millisecond'))
       RETURNING id`,
      [clientId, site, staleAfterMs],
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

  async finish(id: number, result: SiteHealthData | null, error?: string): Promise<void> {
    await this.pool.query("UPDATE site_health_checks SET finished_at = now(), result = $2, error = $3 WHERE id = $1", [id, result ? JSON.stringify(result) : null, error ?? null]);
  }

  /** The newest finished result, and whether a run is under way now. */
  async latest(clientId: string, staleAfterMs = 15 * 60_000): Promise<{ data?: SiteHealthData; finishedAt?: Date; running: boolean }> {
    const done = await this.pool.query(
      "SELECT result, finished_at FROM site_health_checks WHERE client_id = $1 AND result IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
      [clientId],
    );
    const running = await this.pool.query(
      "SELECT 1 FROM site_health_checks WHERE client_id = $1 AND finished_at IS NULL AND started_at > now() - ($2::int * interval '1 millisecond') LIMIT 1",
      [clientId, staleAfterMs],
    );
    return { data: done.rows[0]?.result ?? undefined, finishedAt: done.rows[0]?.finished_at ?? undefined, running: running.rows.length > 0 };
  }

  /** When the client's last run started, finished or not. */
  async lastStarted(clientId: string): Promise<Date | undefined> {
    const { rows } = await this.pool.query("SELECT max(started_at) AS at FROM site_health_checks WHERE client_id = $1", [clientId]);
    return rows[0]?.at ?? undefined;
  }
}

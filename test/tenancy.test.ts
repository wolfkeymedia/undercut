import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientRegistry, clientIdFromName } from "../src/store/clients.js";
import { migrate, PostgresRepository } from "../src/store/postgres.js";

const baseUrl = process.env.TEST_DATABASE_URL;

describe("client ids", () => {
  it("come from the business name", () => {
    expect(clientIdFromName("SOSU Cosmetics")).toBe("sosu-cosmetics");
    expect(clientIdFromName("  Café Ñ & Co. ")).toBe("cafe-n-co");
  });
});

describe.skipIf(!baseUrl)("multi-client storage", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: baseUrl });
    await admin.query("DROP DATABASE IF EXISTS undercut_tenancy_test WITH (FORCE)");
    await admin.query("CREATE DATABASE undercut_tenancy_test");
    await admin.end();
    const u = new URL(baseUrl!);
    u.pathname = "/undercut_tenancy_test";
    pool = new pg.Pool({ connectionString: u.toString() });
  });
  afterAll(async () => pool?.end());

  it("moves an existing single-client database into the client 'default'", async () => {
    // Apply the migrations before clients existed, add data the old way, then upgrade.
    const { mkdtemp, cp, rm } = await import("node:fs/promises");
    const dir = await mkdtemp("/tmp/undercut-mig-");
    for (const f of ["001_init.sql", "002_sales_velocity.sql", "003_tracked_urls.sql"]) await cp(`db/migrations/${f}`, `${dir}/${f}`);
    await migrate(pool, dir);
    await rm(dir, { recursive: true });
    await pool.query(`INSERT INTO stores (id, name, url, kind) VALUES ('mine', 'Mine', 'https://mine.example', 'merchant'), ('them', 'Them', 'https://them.example', 'competitor')`);
    await pool.query(`INSERT INTO product_matches VALUES ('1', 'them', '9', 0.9, 'confirmed', now())`);

    expect(await migrate(pool)).toEqual(["004_clients.sql", "005_site_health.sql"]);
    const repo = new PostgresRepository(pool, "default", false);
    expect((await repo.listStores()).map((s) => [s.id, s.kind])).toEqual([["mine", "merchant"], ["them", "competitor"]]);
    expect(await repo.listMatches("confirmed")).toHaveLength(1);
    expect((await new ClientRegistry(pool).get("default"))?.name).toBe("Mine");
  });

  it("shares a competitor's data but not pairs, roles or events of other stores", async () => {
    const registry = new ClientRegistry(pool);
    const b = await registry.create("Brand B");
    const repoA = new PostgresRepository(pool, "default", false);
    const repoB = repoA.forClient(b.id);
    await repoB.upsertStore({ id: "them", name: "Them", url: "https://them.example", kind: "competitor" });
    await repoB.upsertStore({ id: "bee", name: "Bee", url: "https://bee.example", kind: "merchant" });

    expect((await repoB.listStores()).map((s) => s.id)).toEqual(["bee", "them"]);
    expect(await repoB.listMatches()).toEqual([]);
    await repoB.saveSuggestedMatches([{ merchantExternalId: "1", competitorStoreId: "them", competitorExternalId: "9", confidence: 0.5, status: "suggested" }]);
    expect((await repoA.listMatches())[0]?.status).toBe("confirmed");
    expect((await repoB.listMatches())[0]?.status).toBe("suggested");

    await repoA.saveEvents([{ storeId: "bee", kind: "price_drop", occurredAt: new Date(), title: "B only" }]);
    expect(await repoA.listEvents(new Date(Date.now() - 60_000))).toEqual([]);
    expect(await repoB.listEvents(new Date(Date.now() - 60_000))).toHaveLength(1);

    expect((await registry.storesToCheck()).find((s) => s.id === "them")?.clientIds).toEqual(["brand-b", "default"]);
    await repoB.removeStore("them");
    expect((await repoB.listStores()).map((s) => s.id)).toEqual(["bee"]);
    expect(await repoA.getStore("them")).not.toBeNull();
    expect(await registry.create("Brand B")).toMatchObject({ id: "brand-b-2" });
  });
});

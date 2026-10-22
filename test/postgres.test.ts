import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, PostgresRepository } from "../src/store/postgres.js";
import type { StoreObservation } from "../src/types.js";

// Runs only when a disposable database is provided, e.g.
// TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/undercut_test npm test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PostgresRepository", () => {
  let repo: PostgresRepository;

  beforeAll(async () => {
    const pool = new pg.Pool({ connectionString: url });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    repo = new PostgresRepository(pool);
  });
  afterAll(async () => repo?.close());

  it("round-trips stores, observations, costs, events and matches", async () => {
    await repo.upsertStore({ id: "mine", name: "Mine", url: "https://mine.example", kind: "merchant" });
    await repo.upsertStore({ id: "them", name: "Them", url: "https://them.example", kind: "competitor" });
    expect((await repo.listStores("competitor")).map((s) => s.id)).toEqual(["them"]);

    const observation: StoreObservation = {
      storeId: "mine",
      observedAt: new Date("2026-10-20T08:00:00Z"),
      source: "shopify_feed",
      promotions: [{ key: "percent_off:10", kind: "percent_off", percentOff: 10, text: "10% off" }],
      products: [
        { externalId: "1", title: "Espresso", url: "https://mine.example/products/espresso", priceCents: 3600, available: true },
        { externalId: "2", title: "Decaf", url: "https://mine.example/products/decaf", priceCents: 1500, compareAtCents: 1800, available: false, currency: "USD" },
      ],
    };
    await repo.saveObservation(observation);
    await repo.saveObservation({ ...observation, observedAt: new Date("2026-10-21T08:00:00Z"), products: observation.products.slice(0, 1) });
    expect((await repo.latestObservation("mine"))?.products).toHaveLength(1);

    await repo.setCosts("mine", new Map([["1", 2000]]));
    expect((await repo.currentProducts("mine"))[0]?.costCents).toBe(2000);

    const occurredAt = new Date();
    await repo.saveEvents([{ storeId: "them", kind: "price_drop", occurredAt, externalId: "9", title: "X", beforeCents: 100, afterCents: 90 }]);
    expect(await repo.listEvents(new Date(occurredAt.getTime() - 1000))).toEqual([
      { storeId: "them", kind: "price_drop", occurredAt, externalId: "9", title: "X", beforeCents: 100, afterCents: 90,
        promoKey: undefined, url: undefined, detail: undefined },
    ]);

    const match = { merchantExternalId: "1", competitorStoreId: "them", competitorExternalId: "9", confidence: 0.7, status: "suggested" as const };
    await repo.saveSuggestedMatches([match]);
    await repo.setMatchStatus(match, "rejected");
    await repo.saveSuggestedMatches([{ ...match, confidence: 0.9 }]);
    expect(await repo.listMatches()).toEqual([expect.objectContaining({ status: "rejected", confidence: expect.closeTo(0.7, 5) })]);
  });

  it("does not reapply migrations", async () => {
    expect(await migrate(repo.db)).toEqual([]);
  });
});

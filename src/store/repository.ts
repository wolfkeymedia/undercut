import type { ChangeEvent, ProductEconomics, ProductMatch, ProductSnapshot, Store, StoreObservation } from "../types.js";

/**
 * Everything the pipeline needs to persist, as seen by one client: its own
 * store, its competitors, its product pairs. Postgres in production, memory in tests.
 */
export interface Repository {
  upsertStore(store: Store): Promise<void>;
  getStore(id: string): Promise<Store | null>;
  listStores(kind?: Store["kind"]): Promise<Store[]>;
  /** Stops watching a store. Its history stays, in case another client watches it too. */
  removeStore(id: string): Promise<void>;

  saveObservation(observation: StoreObservation): Promise<void>;
  latestObservation(storeId: string): Promise<StoreObservation | null>;
  /** Merchant-supplied unit costs and sales velocity, keyed by product externalId. */
  setEconomics(storeId: string, economics: Map<string, ProductEconomics>): Promise<void>;
  /** Current products of a store, with costs and sales velocity merged in for the merchant. */
  currentProducts(storeId: string): Promise<ProductSnapshot[]>;

  saveEvents(events: ChangeEvent[]): Promise<void>;
  listEvents(since: Date, until?: Date): Promise<ChangeEvent[]>;

  saveSuggestedMatches(matches: ProductMatch[]): Promise<void>;
  listMatches(status?: ProductMatch["status"]): Promise<ProductMatch[]>;
  setMatchStatus(
    key: Pick<ProductMatch, "merchantExternalId" | "competitorStoreId" | "competitorExternalId">,
    status: ProductMatch["status"],
  ): Promise<void>;

  /** Product pages to check on every run, on top of what the store's feed or sitemap lists. */
  addTrackedUrl(storeId: string, url: string): Promise<void>;
  trackedUrls(storeId: string): Promise<string[]>;

  /** Where the next slice of a large store's product pages starts. */
  crawlCursor(storeId: string): Promise<number>;
  setCrawlCursor(storeId: string, cursor: number): Promise<void>;

  close(): Promise<void>;
}

export function matchKey(m: Pick<ProductMatch, "merchantExternalId" | "competitorStoreId" | "competitorExternalId">): string {
  return `${m.merchantExternalId}|${m.competitorStoreId}|${m.competitorExternalId}`;
}

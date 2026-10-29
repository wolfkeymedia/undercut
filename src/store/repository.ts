import type { ChangeEvent, ProductEconomics, ProductMatch, ProductSnapshot, Store, StoreObservation } from "../types.js";

/** Everything the pipeline needs to persist. Postgres in production, memory in tests. */
export interface Repository {
  upsertStore(store: Store): Promise<void>;
  getStore(id: string): Promise<Store | null>;
  listStores(kind?: Store["kind"]): Promise<Store[]>;

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

  close(): Promise<void>;
}

export function matchKey(m: Pick<ProductMatch, "merchantExternalId" | "competitorStoreId" | "competitorExternalId">): string {
  return `${m.merchantExternalId}|${m.competitorStoreId}|${m.competitorExternalId}`;
}

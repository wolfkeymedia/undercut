import type { ChangeEvent, ProductMatch, ProductSnapshot, Store, StoreObservation } from "../types.js";
import { matchKey, type Repository } from "./repository.js";

export class MemoryRepository implements Repository {
  private stores = new Map<string, Store>();
  private observations = new Map<string, StoreObservation[]>();
  private costs = new Map<string, Map<string, number>>();
  private events: ChangeEvent[] = [];
  private matches = new Map<string, ProductMatch>();

  async upsertStore(store: Store) {
    this.stores.set(store.id, store);
  }
  async getStore(id: string) {
    return this.stores.get(id) ?? null;
  }
  async listStores(kind?: Store["kind"]) {
    return [...this.stores.values()].filter((s) => !kind || s.kind === kind);
  }

  async saveObservation(observation: StoreObservation) {
    const list = this.observations.get(observation.storeId) ?? [];
    list.push(structuredClone(observation));
    this.observations.set(observation.storeId, list);
  }
  async latestObservation(storeId: string) {
    const list = this.observations.get(storeId);
    return list?.length ? structuredClone(list[list.length - 1]!) : null;
  }
  async setCosts(storeId: string, costs: Map<string, number>) {
    const existing = this.costs.get(storeId) ?? new Map<string, number>();
    for (const [id, cost] of costs) existing.set(id, cost);
    this.costs.set(storeId, existing);
  }
  async currentProducts(storeId: string): Promise<ProductSnapshot[]> {
    const latest = await this.latestObservation(storeId);
    const costs = this.costs.get(storeId);
    return (latest?.products ?? []).map((p) => ({ ...p, costCents: costs?.get(p.externalId) ?? p.costCents }));
  }

  async saveEvents(events: ChangeEvent[]) {
    this.events.push(...events.map((e) => structuredClone(e)));
  }
  async listEvents(since: Date, until = new Date(8.64e15)) {
    return this.events.filter((e) => e.occurredAt >= since && e.occurredAt <= until).map((e) => structuredClone(e));
  }

  async saveSuggestedMatches(matches: ProductMatch[]) {
    for (const m of matches) {
      const existing = this.matches.get(matchKey(m));
      // A merchant's confirm or reject decision is never overwritten by a new suggestion.
      if (existing && existing.status !== "suggested") continue;
      this.matches.set(matchKey(m), { ...m });
    }
  }
  async listMatches(status?: ProductMatch["status"]) {
    return [...this.matches.values()].filter((m) => !status || m.status === status);
  }
  async setMatchStatus(key: Parameters<Repository["setMatchStatus"]>[0], status: ProductMatch["status"]) {
    const m = this.matches.get(matchKey(key));
    if (m) m.status = status;
  }

  async close() {}
}

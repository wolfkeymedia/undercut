import { rankEvents } from "./brief/rank.js";
import { writeBrief } from "./brief/write.js";
import { collectStore, type CollectOptions } from "./collectors/index.js";
import type { Fetcher } from "./collectors/http.js";
import { detectChanges } from "./detect/changes.js";
import { suggestMatches } from "./match/matcher.js";
import type { Repository } from "./store/repository.js";
import type { ChangeEvent, Store, StoreObservation } from "./types.js";

/** Collects one store, records what changed since its last check, and saves both. */
export async function checkStore(
  repo: Repository,
  fetcher: Fetcher,
  store: Store,
  options?: CollectOptions,
): Promise<{ observation: StoreObservation; events: ChangeEvent[] }> {
  const observation = await collectStore(fetcher, store, options);
  const previous = await repo.latestObservation(store.id);
  // An empty result usually means we were blocked, not that the store sells nothing.
  if (observation.products.length === 0 && previous && previous.products.length > 0) {
    throw new Error(`No products collected from ${store.url}; keeping the previous observation`);
  }
  const events = detectChanges(previous, observation);
  await repo.saveObservation(observation);
  await repo.saveEvents(events);
  return { observation, events };
}

/** Re-suggests matches between the merchant's catalog and each competitor's latest products. */
export async function refreshMatches(repo: Repository): Promise<number> {
  const [merchant] = await repo.listStores("merchant");
  if (!merchant) return 0;
  const mine = await repo.currentProducts(merchant.id);
  let count = 0;
  for (const competitor of await repo.listStores("competitor")) {
    const theirs = await repo.currentProducts(competitor.id);
    const matches = suggestMatches(mine, competitor.id, theirs);
    await repo.saveSuggestedMatches(matches);
    count += matches.length;
  }
  return count;
}

export async function buildBrief(repo: Repository, since: Date, until = new Date()) {
  const [merchant] = await repo.listStores("merchant");
  if (!merchant) throw new Error("Add your own store first with: undercut add-store --merchant <url>");
  const competitors = await repo.listStores("competitor");
  const competitorIds = new Set(competitors.map((s) => s.id));
  const events = (await repo.listEvents(since, until)).filter((e) => competitorIds.has(e.storeId));
  const merchantProducts = await repo.currentProducts(merchant.id);
  const items = rankEvents({
    events,
    stores: competitors,
    matches: await repo.listMatches("confirmed"),
    merchantProducts,
    currency: merchantProducts[0]?.currency,
  });
  return writeBrief(items, { merchantName: merchant.name, weekOf: since, currency: merchantProducts[0]?.currency });
}

export function storeIdFromUrl(url: string): string {
  return new URL(url).host.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

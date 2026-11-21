import { sendAlerts } from "../alerts.js";
import { politeFetcher, type Fetcher } from "../collectors/http.js";
import { DEFAULT_CONFIG, withClientSettings } from "../config.js";
import { buildInsights, checkStore, refreshMatches } from "../pipeline.js";
import { adminGraphQL, fetchEconomics } from "../shopify/sync.js";
import type { Client, ClientRegistry } from "../store/clients.js";
import type { PostgresRepository } from "../store/postgres.js";
import type { Secrets } from "./secrets.js";

/**
 * The scheduled work, in pieces small enough for a serverless function:
 * each store is checked in its own invocation, and a large store that runs out of
 * time carries on in a follow-up invocation from where it stopped.
 */

export interface CheckResult {
  storeId: string;
  complete: boolean;
  products: number;
  changes: number;
  error?: string;
}

/** Checks one store within a time budget and refreshes product pairs for every client watching it. */
export async function checkOneStore(
  root: PostgresRepository,
  registry: ClientRegistry,
  storeId: string,
  options: { budgetMs: number; fetcher?: Fetcher },
): Promise<CheckResult> {
  const target = (await registry.storesToCheck()).find((s) => s.id === storeId);
  if (!target) return { storeId, complete: true, products: 0, changes: 0, error: "No active client watches this store" };
  // Store data is shared, so any watching client's view can collect it; the kind only matters to that client.
  const repo = root.forClient(target.clientIds[0]!);
  const store = (await repo.getStore(storeId))!;
  try {
    const { observation, events, complete } = await checkStore(repo, options.fetcher ?? politeFetcher({ minIntervalMs: 1_000 }), store, {
      deadline: Date.now() + options.budgetMs,
      renderer: null,
    });
    await registry.recordCheck(storeId);
    for (const clientId of target.clientIds) await refreshMatches(root.forClient(clientId));
    return { storeId, complete, products: observation.products.length, changes: events.length };
  } catch (err) {
    const message = (err as Error).message;
    await registry.recordCheck(storeId, message);
    return { storeId, complete: true, products: 0, changes: 0, error: message };
  }
}

/** Pulls costs and recent sales from a client's Shopify install into its own store's products. */
export async function syncShopify(root: PostgresRepository, registry: ClientRegistry, secrets: Secrets, client: Client): Promise<number> {
  const install = await registry.shopifyToken(client.id);
  if (!install) return 0;
  const repo = root.forClient(client.id);
  const [merchant] = await repo.listStores("merchant");
  if (!merchant) return 0;
  const economics = await fetchEconomics(adminGraphQL(install.shop, secrets.decrypt(install.tokenEnc)));
  await repo.setEconomics(merchant.id, economics);
  await registry.markShopifySynced(client.id);
  return economics.size;
}

/** After the day's checks: refresh pairs, pull Shopify figures, send each client's urgent alerts. */
export async function finishClient(
  root: PostgresRepository,
  registry: ClientRegistry,
  secrets: Secrets | null,
  client: Client,
  since: Date,
): Promise<{ clientId: string; synced?: number; alerted?: number; error?: string }> {
  const repo = root.forClient(client.id);
  const out: { clientId: string; synced?: number; alerted?: number; error?: string } = { clientId: client.id };
  try {
    if (secrets && client.shopify?.hasToken) out.synced = await syncShopify(root, registry, secrets, client);
  } catch (err) {
    out.error = `Shopify: ${(err as Error).message}`;
  }
  try {
    await refreshMatches(repo);
    const config = withClientSettings(DEFAULT_CONFIG, client.settings);
    if (config.alerts.webhookUrl && (await repo.listStores("merchant")).length > 0) {
      const insights = await buildInsights(repo, config, since);
      out.alerted = await sendAlerts(insights.items, {
        webhookUrl: config.alerts.webhookUrl,
        minScore: config.alerts.minScore,
        merchantName: insights.merchant.name,
        currency: insights.currency,
      });
    }
  } catch (err) {
    out.error = [out.error, (err as Error).message].filter(Boolean).join("; ");
  }
  return out;
}

import { rankEvents } from "./brief/rank.js";
import { writeBrief } from "./brief/write.js";
import { collectProductPages, collectStore, type CollectOptions } from "./collectors/index.js";
import type { Fetcher } from "./collectors/http.js";
import type { Renderer } from "./collectors/render.js";
import { detectChanges } from "./detect/changes.js";
import { suggestMatches } from "./match/matcher.js";
import type { Repository } from "./store/repository.js";
import { DEFAULT_CONFIG, type Config } from "./config.js";
import { buildScorecard } from "./insights/position.js";
import { recommendPrices } from "./insights/pricing.js";
import { describePattern, promoPatterns } from "./insights/promos.js";
import { formatCents } from "./money.js";
import type { ChangeEvent, ProductSnapshot, Store, StoreObservation } from "./types.js";

/** Collects one store, records what changed since its last check, and saves both. */
export async function checkStore(
  repo: Repository,
  fetcher: Fetcher,
  store: Store,
  options?: CollectOptions,
): Promise<{ observation: StoreObservation; events: ChangeEvent[] }> {
  const tracked = await repo.trackedUrls(store.id);
  const productUrls = [...new Set([...tracked, ...(options?.productUrls ?? [])])];
  const observation = await collectStore(fetcher, store, { ...options, productUrls });
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

const DAY = 24 * 60 * 60 * 1000;

/** Everything a manager needs for the week, computed once and shared by the brief, the report and alerts. */
export async function buildInsights(repo: Repository, config: Config, since: Date, until = new Date()) {
  const [merchant] = await repo.listStores("merchant");
  if (!merchant) throw new Error("Add your own store first with: undercut add-store <url> --merchant");
  const competitors = await repo.listStores("competitor");
  const competitorIds = new Set(competitors.map((s) => s.id));
  const merchantProducts = await repo.currentProducts(merchant.id);
  const currency = merchantProducts.find((p) => p.currency)?.currency;
  const matches = await repo.listMatches("confirmed");

  const competitorProducts = new Map<string, ProductSnapshot[]>();
  for (const c of competitors) competitorProducts.set(c.id, await repo.currentProducts(c.id));

  const events = (await repo.listEvents(since, until)).filter((e) => competitorIds.has(e.storeId));
  const items = rankEvents({
    events,
    stores: competitors,
    matches,
    merchantProducts,
    currency,
    minMarginPercent: config.pricing.minMarginPercent,
    priceSensitivity: config.priceSensitivity,
    maxShareAtRisk: config.maxShareAtRisk,
  });
  const scorecard = buildScorecard({ merchantProducts, competitorProducts, stores: competitors, matches, config });
  const recommendations = recommendPrices(scorecard.positions, config.pricing, currency);

  // Promo rhythm needs months of history, not just this week.
  const history = (await repo.listEvents(new Date(until.getTime() - 180 * DAY), until)).filter((e) => competitorIds.has(e.storeId));
  const patterns = promoPatterns(history, competitors);

  const money = (c: number) => formatCents(c, currency);
  const headline: string[] = [];
  const t = scorecard.totals;
  if (t.revenueAtRiskCents > 0) {
    headline.push(
      `About ${money(t.revenueAtRiskCents)} a week of your sales is exposed to cheaper competitors` +
        (t.marginAtRiskCents > 0 ? ` (${money(t.marginAtRiskCents)} of margin)` : "") +
        ".",
    );
  }
  if (t.undercutWithoutSalesData > 0) {
    headline.push(`${t.undercutWithoutSalesData} undercut products have no sales data. Import units_per_week to put a figure on them.`);
  }
  const raises = recommendations.filter((r) => r.action === "raise");
  const headroom = raises.reduce((sum, r) => sum + (r.weeklyMarginImpactCents ?? 0), 0);
  if (headroom > 0) {
    headline.push(`Raising ${raises.length} prices where you are the cheapest would add about ${money(headroom)} a week in margin if sales hold.`);
  }
  const holds = recommendations.filter((r) => r.action === "hold");
  if (holds.length > 0) {
    const saved = holds.reduce((sum, r) => sum - (r.weeklyMarginImpactCents ?? 0), 0);
    headline.push(
      `${holds.length} undercuts are not worth matching: cutting would cost about ${money(saved)} a week more in margin than the sales it protects.`,
    );
  }
  if (t.matchedProducts > 0) {
    const parts = [
      t.cheapest && `cheapest on ${t.cheapest}`,
      t.matched && `level on ${t.matched}`,
      t.undercut && `undercut on ${t.undercut}`,
      t.noRivalInStock && `the only one in stock on ${t.noRivalInStock}`,
    ].filter((x): x is string => Boolean(x));
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
    headline.push(`Of ${t.matchedProducts} products you sell against competitors, you are ${list}.`);
  }
  for (const ix of scorecard.indexes) {
    const diff = Math.round((ix.index - 100) * 10) / 10;
    const where = diff === 0 ? "level" : diff > 0 ? `${diff}% more expensive` : `${-diff}% cheaper`;
    headline.push(`Against ${ix.storeName} you are ${where} across ${ix.comparedProducts} shared products (price index ${ix.index}).`);
  }
  for (const p of patterns) {
    const line = describePattern(p, until);
    if (line) headline.push(line);
  }

  const priceActions = recommendations
    .slice(0, 6)
    .map((r) =>
      r.action === "hold"
        ? `${r.title}: hold at ${money(r.currentCents)}. ${r.reason}`
        : `${r.title}: ${money(r.currentCents)} to ${money(r.recommendedCents)}. ${r.reason}`,
    );

  return { merchant, competitors, merchantProducts, currency, items, scorecard, recommendations, patterns, headline, priceActions };
}

export type Insights = Awaited<ReturnType<typeof buildInsights>>;

export async function buildBrief(repo: Repository, since: Date, until = new Date(), config: Config = DEFAULT_CONFIG) {
  const insights = await buildInsights(repo, config, since, until);
  const brief = await writeBrief(insights.items, {
    merchantName: insights.merchant.name,
    weekOf: since,
    currency: insights.currency,
    headline: insights.headline,
    priceActions: insights.priceActions,
  });
  return { ...brief, insights };
}

/** Product URLs compare equal regardless of query string, fragment, trailing slash or "www.". */
export function sameProductUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    const x = new URL(u);
    return `${x.host.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`.toLowerCase();
  };
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * Pairs one of your products with an equivalent competitor product by hand,
 * for brands that sell their own lines rather than the same items. The pair is
 * saved as confirmed, and the competitor page is checked on every run from now on.
 */
export async function pairProducts(repo: Repository, fetcher: Fetcher, yourUrl: string, theirUrl: string, renderer: Renderer | null = null) {
  const [merchant] = await repo.listStores("merchant");
  if (!merchant) throw new Error("Add your store first with: undercut add-store <url> --merchant");
  const yours = (await repo.currentProducts(merchant.id)).find((p) => sameProductUrl(p.url, yourUrl));
  if (!yours) throw new Error(`${yourUrl} is not in your catalog yet. Run \`undercut run\` first, then pair again.`);

  const theirHost = new URL(theirUrl).host.replace(/^www\./, "");
  const competitor = (await repo.listStores("competitor")).find((s) => new URL(s.url).host.replace(/^www\./, "") === theirHost);
  if (!competitor) throw new Error(`${theirHost} is not one of your competitors. Add it with: undercut add-store https://${theirHost}`);

  let theirs = (await repo.currentProducts(competitor.id)).find((p) => sameProductUrl(p.url, theirUrl));
  if (!theirs) {
    // Not collected yet (stores without a Shopify feed are read page by page): read this page now.
    [theirs] = await collectProductPages(fetcher, [theirUrl], renderer);
    if (!theirs) throw new Error(`Couldn't read a product and price from ${theirUrl}.`);
  }
  await repo.addTrackedUrl(competitor.id, theirs.url);

  const key = { merchantExternalId: yours.externalId, competitorStoreId: competitor.id, competitorExternalId: theirs.externalId };
  await repo.saveSuggestedMatches([{ ...key, confidence: 1, status: "suggested" }]);
  await repo.setMatchStatus(key, "confirmed");
  return { yours, theirs, competitor };
}

export function storeIdFromUrl(url: string): string {
  return new URL(url).host.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

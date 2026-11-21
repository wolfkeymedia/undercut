import type { BriefItem } from "../brief/rank.js";
import { percentChange } from "../money.js";
import type { ChangeEvent, Promotion, Store } from "../types.js";
import type { ProductPosition } from "./position.js";

// ---------- price gap alerts ----------

export interface PriceGapAlert {
  title: string;
  url: string;
  yourPriceCents: number;
  /** The rival price the gap is measured against: the cheapest one in stock, or the market average. */
  rivalPriceCents: number;
  rivalName: string;
  /** Your price minus theirs. Positive means you cost more. */
  gapCents: number;
  /** Gap as a percent of their price: "you are 12% above them". */
  gapPercent: number;
  rivalsCompared: number;
}

export interface PriceGapReport {
  /** At least one rival in stock sells the paired product for less than you. */
  cheaperRivals: PriceGapAlert[];
  /** You are well above the average of every rival in stock, not just one. */
  pricedAbove: PriceGapAlert[];
  /** Percent above the market average that counts as "well above". */
  abovePercent: number;
}

/** Prices this close count as level, as in the scorecard. */
const LEVEL_PERCENT = 0.5;

/**
 * Where a rival is cheaper than you, and where you sit well above the market
 * as a whole, with the gap in money and percent. Uses only confirmed pairs and
 * rivals that have the product in stock.
 */
export function priceGapAlerts(positions: ProductPosition[], abovePercent = 10): PriceGapReport {
  const cheaperRivals: PriceGapAlert[] = [];
  const pricedAbove: PriceGapAlert[] = [];
  for (const pos of positions) {
    const inStock = pos.rivals.filter((r) => r.available);
    if (!inStock.length) continue;
    const you = pos.product.priceCents;
    const avg = Math.round(inStock.reduce((s, r) => s + r.priceCents, 0) / inStock.length);
    const base = { title: pos.product.title, url: pos.product.url, yourPriceCents: you, rivalsCompared: inStock.length };
    const aboveAvg = percentChange(avg, you);
    if (aboveAvg >= abovePercent) {
      pricedAbove.push({
        ...base,
        rivalPriceCents: avg,
        rivalName: inStock.length === 1 ? inStock[0]!.storeName : `average of ${inStock.length} rivals`,
        gapCents: you - avg,
        gapPercent: round1(aboveAvg),
      });
      continue;
    }
    const cheapest = inStock.reduce((a, b) => (b.priceCents < a.priceCents ? b : a));
    const gap = percentChange(cheapest.priceCents, you);
    if (gap > LEVEL_PERCENT) {
      cheaperRivals.push({ ...base, rivalPriceCents: cheapest.priceCents, rivalName: cheapest.storeName, gapCents: you - cheapest.priceCents, gapPercent: round1(gap) });
    }
  }
  const byGap = (a: PriceGapAlert, b: PriceGapAlert) => b.gapPercent - a.gapPercent || b.gapCents - a.gapCents;
  return { cheaperRivals: cheaperRivals.sort(byGap), pricedAbove: pricedAbove.sort(byGap), abovePercent };
}

// ---------- promo tracker ----------

export interface TrackedPromo {
  storeId: string;
  storeName: string;
  text: string;
  code?: string;
  percentOff?: number;
  kind?: Promotion["kind"];
  /** First check that saw it. Missing when it was already running on our first check of the store. */
  startedAt?: Date;
  /** First check that no longer saw it. Missing while it runs. */
  endedAt?: Date;
  running: boolean;
  /** Days between the first check that saw it and the first that didn't (or now, while it runs). */
  days?: number;
  /** One line on whether it is worth reacting to. */
  advice: string;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Every competitor sale, discount code and free-shipping offer seen, with the
 * day each started and ended. Built from promotion events plus what is on each
 * homepage now, so a sale that was already running when we started watching
 * still shows. Several promotions read from one banner count as one.
 */
export function trackPromos(input: {
  events: ChangeEvent[];
  stores: Store[];
  /** What each competitor's homepage shows on its latest check. */
  current: Map<string, Promotion[]>;
  now?: Date;
}): TrackedPromo[] {
  const now = input.now ?? new Date();
  const storeName = new Map(input.stores.map((s) => [s.id, s.name]));
  const watched = new Set(input.stores.map((s) => s.id));
  const promos: TrackedPromo[] = [];
  const open = new Map<string, TrackedPromo>();
  const closed = new Map<string, TrackedPromo>();
  const bannerKey = (storeId: string, text: string) => `${storeId}|${text.trim().toLowerCase()}`;

  const sorted = input.events
    .filter((e) => (e.kind === "promo_started" || e.kind === "promo_ended") && watched.has(e.storeId))
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  for (const e of sorted) {
    const key = bannerKey(e.storeId, e.title);
    const pct = percentFromKey(e.promoKey);
    if (e.kind === "promo_started") {
      const already = open.get(key);
      if (already) {
        // Another promotion read from the same banner: keep the deepest discount and any code.
        if (pct && (!already.percentOff || pct > already.percentOff)) already.percentOff = pct;
        if (e.detail && !already.code) already.code = e.detail;
        continue;
      }
      const promo: TrackedPromo = { storeId: e.storeId, storeName: storeName.get(e.storeId) ?? e.storeId, text: e.title, code: e.detail || undefined, percentOff: pct, kind: kindFromKey(e.promoKey), startedAt: e.occurredAt, running: true, advice: "" };
      open.set(key, promo);
      promos.push(promo);
    } else {
      const promo = open.get(key);
      if (promo) {
        promo.endedAt = e.occurredAt;
        promo.running = false;
        open.delete(key);
        closed.set(key, promo);
      } else if (closed.get(key)?.endedAt?.getTime() === e.occurredAt.getTime()) {
        // Another promotion from the same banner, ending on the same check.
        continue;
      } else {
        // Ended before our history window starts: we only know when it stopped.
        promos.push({ storeId: e.storeId, storeName: storeName.get(e.storeId) ?? e.storeId, text: e.title, code: e.detail || undefined, percentOff: pct, kind: kindFromKey(e.promoKey), endedAt: e.occurredAt, running: false, advice: "" });
      }
    }
  }

  // Seen starting but gone from the homepage now, without an end on record: it is over.
  for (const [key, promo] of open) {
    const now = input.current.get(promo.storeId);
    if (now && !now.some((p) => bannerKey(promo.storeId, p.text) === key)) {
      promo.running = false;
      open.delete(key);
    }
  }

  // Running now but never seen starting: it was up before the first check.
  for (const [storeId, list] of input.current) {
    if (!watched.has(storeId)) continue;
    for (const p of list) {
      const key = bannerKey(storeId, p.text);
      const already = open.get(key);
      if (already) {
        if (p.percentOff && (!already.percentOff || p.percentOff > already.percentOff)) already.percentOff = p.percentOff;
        if (p.code && !already.code) already.code = p.code;
        continue;
      }
      const promo: TrackedPromo = { storeId, storeName: storeName.get(storeId) ?? storeId, text: p.text, code: p.code, percentOff: p.percentOff, kind: p.kind, running: true, advice: "" };
      open.set(key, promo);
      promos.push(promo);
    }
  }

  for (const p of promos) {
    if (p.startedAt && (p.running || p.endedAt)) p.days = Math.max(0, Math.round(((p.endedAt ?? now).getTime() - p.startedAt.getTime()) / DAY));
    p.advice = promoAdvice(p);
  }
  // Running first, newest first; then ended, most recently ended first.
  const when = (p: TrackedPromo) => (p.running ? p.startedAt : (p.endedAt ?? p.startedAt))?.getTime() ?? 0;
  return promos.sort((a, b) => Number(b.running) - Number(a.running) || when(b) - when(a));
}

/** Plain advice from the depth and kind of the offer. Deliberately cautious: it can't see your sales. */
export function promoAdvice(p: Pick<TrackedPromo, "running" | "percentOff" | "kind" | "code" | "days">): string {
  if (!p.running) {
    return p.days !== undefined ? `Ran for ${p.days} ${p.days === 1 ? "day" : "days"}. Useful for spotting how long their sales usually last.` : "Already over. No action needed.";
  }
  const pct = p.percentOff;
  if (pct !== undefined && pct >= 25) return `A deep discount. Match only on products where you are already close on price, or skip it and promote what they don't sell.`;
  if (pct !== undefined && pct >= 10) return `A typical seasonal sale. Worth matching with a short offer if it lands on your best sellers; otherwise skip.`;
  if (pct !== undefined) return `A small discount. Usually safe to skip.`;
  if (p.kind === "free_shipping") return `Free shipping offer. If yours costs more to reach, consider matching the threshold.`;
  if (p.kind === "discount_code" || p.code) return `A code, so only shoppers who find it get the deal. Usually safe to skip.`;
  return `A sale banner with no stated discount. Check their site before reacting.`;
}

function percentFromKey(key?: string): number | undefined {
  const n = Number(key?.match(/^percent_off:(\d+)/)?.[1]);
  return n > 0 ? n : undefined;
}

function kindFromKey(key?: string): Promotion["kind"] | undefined {
  const k = key?.split(":")[0];
  return k === "percent_off" || k === "amount_off" || k === "free_shipping" || k === "discount_code" || k === "sale_banner" ? k : undefined;
}

// ---------- weekly brief ----------

export interface PriceMove {
  competitor: string;
  title: string;
  url?: string;
  direction: "down" | "up";
  beforeCents: number;
  afterCents: number;
  changeCents: number;
  changePercent: number;
  /** One line on why it matters, from the numbers. */
  reason: string;
  /** Weekly sales at risk, only when it can be worked out from data in the app. */
  valueCents?: number;
  /** Why there is no money figure, when there isn't one. */
  noValueReason?: string;
}

/**
 * The week's biggest competitor price moves, most important first, each with
 * one plain reason. A money figure is shown only when it can be calculated
 * from what the app holds (a paired product with weekly sales); otherwise the
 * move is shown on its own with the reason there is no figure.
 */
export function weeklyPriceMoves(items: BriefItem[], money: (cents: number) => string, limit = 8): PriceMove[] {
  return items
    .filter((i) => (i.event.kind === "price_drop" || i.event.kind === "price_increase") && i.event.beforeCents !== undefined && i.event.afterCents !== undefined)
    .slice(0, limit)
    .map((i) => {
      const before = i.event.beforeCents!;
      const after = i.event.afterCents!;
      const move: PriceMove = {
        competitor: i.competitor,
        title: i.event.title,
        url: i.event.url,
        direction: after < before ? "down" : "up",
        beforeCents: before,
        afterCents: after,
        changeCents: after - before,
        changePercent: round1(percentChange(before, after)),
        reason: moveReason(i, money),
      };
      if (i.revenueAtRiskCents !== undefined && i.revenueAtRiskCents > 0) {
        move.valueCents = i.revenueAtRiskCents;
      } else if (!i.yourProduct) {
        move.noValueReason = "Not paired with one of your products, so there is nothing to measure it against.";
      } else if (after >= i.yourProduct.priceCents) {
        move.noValueReason = "They are not cheaper than you, so none of your sales are at risk from it.";
      } else {
        move.noValueReason = "Needs your weekly sales for this product, which aren't connected yet.";
      }
      return move;
    });
}

function moveReason(i: BriefItem, money: (cents: number) => string): string {
  const before = i.event.beforeCents!;
  const after = i.event.afterCents!;
  const yours = i.yourProduct;
  if (!yours) {
    return after < before ? `${i.competitor} cut this price. You don't have a paired product, so it is for awareness only.` : `${i.competitor} raised this price. You don't have a paired product, so it is for awareness only.`;
  }
  if (after === yours.priceCents) return `Now level with your ${yours.title} at ${money(after)}.`;
  const wasCheaper = before < yours.priceCents;
  const nowCheaper = after < yours.priceCents;
  if (nowCheaper && !wasCheaper) return `They now undercut your ${yours.title} by ${money(yours.priceCents - after)}.`;
  if (nowCheaper) return after < before ? `They were already cheaper than your ${yours.title} and the gap grew to ${money(yours.priceCents - after)}.` : `Still cheaper than your ${yours.title}, but the gap shrank to ${money(yours.priceCents - after)}.`;
  if (wasCheaper) return `They are no longer cheaper than your ${yours.title}. You now lead by ${money(after - yours.priceCents)}.`;
  return after < before ? `Closer to your ${yours.title}, but you are still ${money(after - yours.priceCents)} cheaper.` : `You are now ${money(after - yours.priceCents)} cheaper than them on ${yours.title}. Say so in ads.`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

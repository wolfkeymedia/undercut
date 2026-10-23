import type { ChangeEvent, Store } from "../types.js";

export interface PromoPattern {
  storeId: string;
  storeName: string;
  /** Distinct promotion campaigns seen. Promos starting within a few days of each other count as one. */
  campaigns: number;
  lastStartedAt: Date;
  /** Average days between campaign starts. Needs at least two campaigns. */
  averageGapDays?: number;
  /** When the next campaign is likely to start, if there is a pattern. */
  expectedNextAt?: Date;
  /** Typical headline discount, when campaigns advertised a percent off. */
  typicalPercentOff?: number;
}

const SAME_CAMPAIGN_DAYS = 3;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Finds each competitor's promotion rhythm from past promo events, so the
 * merchant can plan around the next sale instead of reacting to it.
 */
export function promoPatterns(events: ChangeEvent[], stores: Store[]): PromoPattern[] {
  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  const starts = new Map<string, ChangeEvent[]>();
  for (const e of events) {
    if (e.kind !== "promo_started") continue;
    const list = starts.get(e.storeId) ?? [];
    list.push(e);
    starts.set(e.storeId, list);
  }

  const patterns: PromoPattern[] = [];
  for (const [storeId, list] of starts) {
    list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const campaigns: { start: Date; percents: number[] }[] = [];
    for (const e of list) {
      const last = campaigns[campaigns.length - 1];
      const pct = Number(e.promoKey?.match(/^percent_off:(\d+)/)?.[1]);
      if (last && e.occurredAt.getTime() - last.start.getTime() <= SAME_CAMPAIGN_DAYS * DAY) {
        if (pct) last.percents.push(pct);
      } else {
        campaigns.push({ start: e.occurredAt, percents: pct ? [pct] : [] });
      }
    }

    const pattern: PromoPattern = {
      storeId,
      storeName: storeName.get(storeId) ?? storeId,
      campaigns: campaigns.length,
      lastStartedAt: campaigns[campaigns.length - 1]!.start,
    };
    if (campaigns.length >= 2) {
      const gaps = campaigns.slice(1).map((c, i) => (c.start.getTime() - campaigns[i]!.start.getTime()) / DAY);
      pattern.averageGapDays = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
      pattern.expectedNextAt = new Date(pattern.lastStartedAt.getTime() + pattern.averageGapDays * DAY);
    }
    const percents = campaigns.flatMap((c) => (c.percents.length ? [Math.max(...c.percents)] : []));
    if (percents.length) {
      const sorted = [...percents].sort((a, b) => a - b);
      pattern.typicalPercentOff = sorted[Math.floor(sorted.length / 2)];
    }
    patterns.push(pattern);
  }
  return patterns.sort((a, b) => (a.expectedNextAt?.getTime() ?? Infinity) - (b.expectedNextAt?.getTime() ?? Infinity));
}

/** "Ridgeway Roasters usually runs a sale every 28 days (typically 20% off). The next is due around Nov 14." */
export function describePattern(p: PromoPattern, now = new Date()): string | undefined {
  if (!p.averageGapDays || !p.expectedNextAt) return undefined;
  const depth = p.typicalPercentOff ? ` (typically ${p.typicalPercentOff}% off)` : "";
  const when = p.expectedNextAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const days = Math.round((p.expectedNextAt.getTime() - now.getTime()) / DAY);
  const due = days < 0 ? `It is ${-days} days overdue, so expect one soon.` : days <= 7 ? `The next is due within a week, around ${when}.` : `The next is due around ${when}.`;
  return `${p.storeName} runs a promotion about every ${p.averageGapDays} days${depth}. ${due}`;
}

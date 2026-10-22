import type { ProductMatch, ProductSnapshot } from "../types.js";

const STOPWORDS = new Set(["the", "a", "an", "and", "with", "for", "of", "in", "by", "new", "-", "&"]);

/** Lowercases, joins numbers to their units ("1 kg" -> "1kg") and drops filler words. */
export function normalizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/(\d+(?:\.\d+)?)\s+(kg|g|mg|lb|lbs|oz|ml|l|cl|cm|mm|m|in|pack|pk|ct|count)\b/g, "$1$2")
    .replace(/[^a-z0-9.]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t));
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** 0..1 similarity between two product titles. */
export function titleSimilarity(a: string, b: string): number {
  const ta = normalizeTitle(a);
  const tb = normalizeTitle(b);
  const tokenScore = dice(new Set(ta), new Set(tb));
  const charScore = dice(trigrams(ta.join(" ")), trigrams(tb.join(" ")));

  // Sizes and quantities must agree: "250g" and "1kg" are different products.
  const units = (t: string[]) => new Set(t.filter((x) => /^\d+(\.\d+)?[a-z]+$/.test(x)));
  const ua = units(ta);
  const ub = units(tb);
  const unitPenalty = ua.size > 0 && ub.size > 0 && dice(ua, ub) === 0 ? 0.35 : 0;

  return Math.max(0, 0.5 * tokenScore + 0.5 * charScore - unitPenalty);
}

export function scorePair(mine: ProductSnapshot, theirs: ProductSnapshot): number {
  let score = titleSimilarity(mine.title, theirs.title);
  if (mine.productType && theirs.productType && mine.productType.toLowerCase() === theirs.productType.toLowerCase()) {
    score += 0.05;
  }
  // Same product rarely costs 3x more elsewhere.
  const ratio = theirs.priceCents / Math.max(1, mine.priceCents);
  if (ratio > 3 || ratio < 1 / 3) score -= 0.2;
  return Math.min(1, Math.max(0, score));
}

export interface MatchOptions {
  /** Pairs scoring below this are not suggested at all. */
  minConfidence?: number;
}

/**
 * Suggests which competitor product corresponds to each merchant product.
 * Assigns greedily from the strongest pair down, so each competitor product is
 * matched at most once. Every result starts as "suggested" until the merchant
 * confirms it.
 */
export function suggestMatches(
  merchantProducts: ProductSnapshot[],
  competitorStoreId: string,
  competitorProducts: ProductSnapshot[],
  options: MatchOptions = {},
): ProductMatch[] {
  const min = options.minConfidence ?? 0.45;
  const pairs: { mine: ProductSnapshot; theirs: ProductSnapshot; score: number }[] = [];
  for (const mine of merchantProducts) {
    for (const theirs of competitorProducts) {
      const score = scorePair(mine, theirs);
      if (score >= min) pairs.push({ mine, theirs, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const usedMine = new Set<string>();
  const usedTheirs = new Set<string>();
  const matches: ProductMatch[] = [];
  for (const { mine, theirs, score } of pairs) {
    if (usedMine.has(mine.externalId) || usedTheirs.has(theirs.externalId)) continue;
    usedMine.add(mine.externalId);
    usedTheirs.add(theirs.externalId);
    matches.push({
      merchantExternalId: mine.externalId,
      competitorStoreId,
      competitorExternalId: theirs.externalId,
      confidence: Math.round(score * 100) / 100,
      status: "suggested",
    });
  }
  return matches;
}

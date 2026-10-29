import type { ChangeEvent, ProductSnapshot, Promotion, Store } from "../types.js";

export interface StoreSummary {
  store: Store;
  currency?: string;
  products: number;
  inStock: number;
  minCents?: number;
  medianCents?: number;
  maxCents?: number;
  /** Products showing a was-price. */
  onOffer: number;
  /** Median saving across products with a was-price, in percent. */
  medianOfferPercent?: number;
  promotions: Promotion[];
}

export interface CategoryRow {
  category: string;
  /** Per store id: how many products and their median price. */
  byStore: Map<string, { count: number; medianCents: number }>;
}

export interface Offer {
  store: Store;
  product: ProductSnapshot;
  percentOff: number;
}

export interface Market {
  summaries: StoreSummary[];
  categories: CategoryRow[];
  offers: Offer[];
  /** Changes worth reading: price moves, stock and promotions. */
  moves: ChangeEvent[];
  /** Event counts per store, including new and removed products. */
  counts: Map<string, Partial<Record<ChangeEvent["kind"], number>>>;
}

// First match wins, so kits and multi-packs are compared with each other rather than with single products.
const CATEGORIES: [string, RegExp][] = [
  ["Kits & sets", /\b(kit|set|duo|trio|trilogy|bundle|collection|gift box|vault)\b/i],
  ["Palettes", /\bpalettes?\b/i],
  ["Foundation", /\bfoundation|\bskin tint/i],
  ["Concealer", /\bconcealer/i],
  ["Primer", /\bprimer/i],
  ["Setting spray", /\bsetting spray|\bsetting mist|\bfix(ing)? spray/i],
  ["Powder", /\bpowder/i],
  ["Bronzer", /\bbronz/i],
  ["Contour", /\bcontour|\bsculpt/i],
  ["Blush", /\bblush/i],
  ["Highlighter", /\bhighlight|\bglow\b|\billuminat/i],
  ["Lip liner", /\blip ?liner|\blip cheat/i],
  ["Lip gloss", /\blip ?gloss|\blip oil|\blip lustre/i],
  ["Lipstick", /\blipstick|\blip colou?r|\blip\b/i],
  ["Mascara", /\bmascara|\blash/i],
  ["Eyeliner", /\beye ?liner|\bkohl/i],
  ["Eyeshadow", /\beye ?shadow|\beye colou?r/i],
  ["Brows", /\bbrow/i],
  ["Brushes & tools", /\bbrush|\bsponge|\bblender|\bsharpener/i],
  ["Skincare", /\bcream|\bserum|\bmoisturi|\bcleans|\btoner|\bmask|\bbalm|\bspf\b|\beye care/i],
  ["Fragrance", /\bfragrance|\bperfume|\beau de\b/i],
];

export function categorize(p: Pick<ProductSnapshot, "title" | "productType">): string {
  for (const [name, re] of CATEGORIES) if (re.test(p.title)) return name;
  return p.productType?.trim() || "Other";
}

export function buildMarket(input: {
  stores: Store[];
  products: Map<string, ProductSnapshot[]>;
  promotions: Map<string, Promotion[]>;
  events: ChangeEvent[];
}): Market {
  const summaries = input.stores.map((store): StoreSummary => {
    const products = input.products.get(store.id) ?? [];
    const prices = products.map((p) => p.priceCents);
    const offers = products.filter((p) => p.compareAtCents && p.compareAtCents > p.priceCents);
    return {
      store,
      currency: products.find((p) => p.currency)?.currency,
      products: products.length,
      inStock: products.filter((p) => p.available).length,
      minCents: prices.length ? Math.min(...prices) : undefined,
      medianCents: median(prices),
      maxCents: prices.length ? Math.max(...prices) : undefined,
      onOffer: offers.length,
      medianOfferPercent: median(offers.map((p) => percentOff(p))),
      promotions: input.promotions.get(store.id) ?? [],
    };
  });

  const grouped = new Map<string, Map<string, number[]>>();
  for (const store of input.stores) {
    for (const p of input.products.get(store.id) ?? []) {
      const cat = categorize(p);
      const byStore = grouped.get(cat) ?? new Map<string, number[]>();
      byStore.set(store.id, [...(byStore.get(store.id) ?? []), p.priceCents]);
      grouped.set(cat, byStore);
    }
  }
  const minStores = Math.min(2, input.stores.length);
  const categories = [...grouped.entries()]
    .filter(([cat, byStore]) => cat !== "Other" && byStore.size >= minStores)
    .map(([category, byStore]): CategoryRow & { total: number } => ({
      category,
      byStore: new Map([...byStore].map(([id, prices]) => [id, { count: prices.length, medianCents: median(prices)! }])),
      total: [...byStore.values()].reduce((s, v) => s + v.length, 0),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 15)
    .map(({ category, byStore }) => ({ category, byStore }));

  const offers = input.stores
    .flatMap((store) =>
      (input.products.get(store.id) ?? [])
        .filter((p) => p.compareAtCents && p.compareAtCents > p.priceCents)
        .map((product) => ({ store, product, percentOff: percentOff(product) })),
    )
    .sort((a, b) => b.percentOff - a.percentOff)
    .slice(0, 15);

  const counts = new Map<string, Partial<Record<ChangeEvent["kind"], number>>>();
  for (const e of input.events) {
    const c = counts.get(e.storeId) ?? {};
    c[e.kind] = (c[e.kind] ?? 0) + 1;
    counts.set(e.storeId, c);
  }
  const moves = input.events
    .filter((e) => e.kind !== "new_product" && e.kind !== "removed_product")
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, 20);

  return { summaries, categories, offers, moves, counts };
}

function percentOff(p: ProductSnapshot): number {
  return Math.round((1 - p.priceCents / p.compareAtCents!) * 100);
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

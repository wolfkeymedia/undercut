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
  /** With your own store: categories rivals sell that you don't, or barely do. */
  gaps: RangeGap[];
  /** With your own store: categories where your median sits far below or above the cheapest rival's. */
  pricePositions: PricePosition[];
}

export interface RangeGap {
  category: string;
  /** How many products you sell in it: 0 for a missing category, a few for a thin one. */
  yourCount: number;
  rivals: { store: Store; count: number; medianCents: number; examples: ProductSnapshot[] }[];
}

export interface PricePosition {
  category: string;
  yourMedianCents: number;
  cheapestRival: { store: Store; medianCents: number };
  /** Your median against the cheapest rival's, in percent: -40 means 40% cheaper. */
  gapPercent: number;
  signal: "headroom" | "above_rival";
}

// First match wins, so kits and multi-packs are compared with each other rather than with single products.
const CATEGORIES: [string, RegExp][] = [
  ["Kits & sets", /\b(kits?|sets?|trio|trilogy|bundle|collection|gift box|vault|edit|routine|look|combo|crackers?|advent)\b|\bduo\b.*[+&]|[+&].*\bduo\b|\bduo\b.* and /i],
  ["Minis", /\bminis?\b|\btravel\b|\bsample/i],
  ["Tanning", /\btanning\b|self.?tan|\btan (mousse|water|lotion|serum|drops|mist|foam|mitt)|bronzing (drops|water|mousse)|\bglow drops/i],
  ["Palettes", /\bpalettes?\b/i],
  ["Foundation", /\bfoundation|\bskin tint/i],
  ["Concealer", /\bconcealer/i],
  ["Primer", /\bprimer/i],
  ["Setting spray", /\bsetting spray|\bsetting mist|\bfix(ing)? spray/i],
  ["Powder", /\bpowder/i],
  ["Bronzer", /\bbronz/i],
  ["Contour", /\bcontour/i],
  ["Blush", /\bblush/i],
  ["Highlighter", /\bhighlight|\bglow\b|\billuminat/i],
  ["Lip liner", /\blip ?liner|\blip cheat/i],
  ["Lip gloss", /\blip ?gloss|\blip oil|\blip lustre/i],
  ["Lipstick", /\blipstick|\blip colou?r|\blip\b/i],
  ["Mascara", /mascara/i],
  ["Lashes", /\blash/i],
  ["Eyeliner", /\beye ?liner|\bkohl/i],
  ["Eyeshadow", /\beye ?shadow|\beye colou?r/i],
  ["Brows", /\bbrow/i],
  ["Brushes & tools", /\bbrush|\bsponge|\bblender|\bsharpener/i],
  ["Skincare", /\bcream|\bserum|\bmoisturi|\bcleans|\btoner|\bmask|\bbalm|\bspf\b|\beye care/i],
  ["Nails", /\bnails?\b|press.?ons?/i],
  ["Bags & cases", /\b(make.?up |cosmetic |wash )?bag\b|\bpouch\b|\bvanity case/i],
  ["Fragrance", /\bfragrance|\bperfume|\beau de\b/i],
];

// Gift cards, courses and merchandise are not products anyone prices against.
const NOT_PRODUCTS = /\b(e-?gift|gift ?cards?|vouchers?|courses?|academy|masterclass|workshops?|application|appointment|add your products|buy more,? save more|key ?chain|keyring|notebook|sweatshirt|hoodie|t-shirt|tee|merch(andise)?|tote)\b/i;

export function isComparable(p: Pick<ProductSnapshot, "title" | "productType">): boolean {
  return !NOT_PRODUCTS.test(p.title) && !NOT_PRODUCTS.test(p.productType ?? "");
}

export function categorize(p: Pick<ProductSnapshot, "title" | "productType">): string {
  // The title is the most specific signal; a store's own section only decides when the title says nothing.
  // Unknown sections stay "Other": stores also file products under campaign names ("Hot Lips 2").
  for (const [name, re] of CATEGORIES) if (re.test(p.title)) return name;
  if (p.productType) for (const [name, re] of CATEGORIES.slice(2)) if (re.test(p.productType)) return name;
  return "Other";
}

export function buildMarket(input: {
  stores: Store[];
  products: Map<string, ProductSnapshot[]>;
  promotions: Map<string, Promotion[]>;
  events: ChangeEvent[];
  /** Your own store's id, to find range gaps and price positions against the rest. */
  merchantId?: string;
}): Market {
  const comparable = new Map([...input.products].map(([id, list]) => [id, list.filter(isComparable)]));
  const summaries = input.stores.map((store): StoreSummary => {
    const products = comparable.get(store.id) ?? [];
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
    for (const p of comparable.get(store.id) ?? []) {
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
      (comparable.get(store.id) ?? [])
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

  const { gaps, pricePositions } = input.merchantId
    ? compareWithMerchant(input.merchantId, input.stores, comparable)
    : { gaps: [], pricePositions: [] };

  return { summaries, categories, offers, moves, counts, gaps, pricePositions };
}

// A category counts as thin when rivals sell at least this many times more of it.
const THIN_RATIO = 4;
// Medians this far under the cheapest rival suggest room to raise prices.
const HEADROOM_PERCENT = -35;

function compareWithMerchant(merchantId: string, stores: Store[], comparable: Map<string, ProductSnapshot[]>) {
  const byCategory = new Map<string, Map<string, ProductSnapshot[]>>();
  for (const store of stores) {
    for (const p of comparable.get(store.id) ?? []) {
      const cat = categorize(p);
      if (cat === "Other") continue;
      const m = byCategory.get(cat) ?? new Map<string, ProductSnapshot[]>();
      m.set(store.id, [...(m.get(store.id) ?? []), p]);
      byCategory.set(cat, m);
    }
  }
  const rivals = stores.filter((s) => s.id !== merchantId);
  const gaps: RangeGap[] = [];
  const pricePositions: PricePosition[] = [];

  for (const [category, m] of byCategory) {
    const yours = m.get(merchantId) ?? [];
    const theirs = rivals
      .map((store) => ({ store, products: m.get(store.id) ?? [] }))
      .filter((r) => r.products.length > 0)
      .map((r) => {
        const medianCents = median(r.products.map((p) => p.priceCents))!;
        // In-stock products nearest the median price are the most typical examples.
        const examples = r.products
          .filter((p) => p.available)
          .sort((a, b) => Math.abs(a.priceCents - medianCents) - Math.abs(b.priceCents - medianCents))
          .slice(0, 3);
        return { store: r.store, count: r.products.length, medianCents, examples };
      });
    if (theirs.length === 0) continue;
    const most = Math.max(...theirs.map((r) => r.count));
    if (yours.length === 0 ? most >= 2 : most >= 5 && most >= yours.length * THIN_RATIO) {
      gaps.push({ category, yourCount: yours.length, rivals: theirs });
    }
    if (yours.length > 0) {
      const yourMedianCents = median(yours.map((p) => p.priceCents))!;
      const cheapest = theirs.reduce((a, b) => (b.medianCents < a.medianCents ? b : a));
      const gapPercent = Math.round((yourMedianCents / cheapest.medianCents - 1) * 100);
      const signal = gapPercent <= HEADROOM_PERCENT ? "headroom" : gapPercent > 0 ? "above_rival" : undefined;
      if (signal) pricePositions.push({ category, yourMedianCents, cheapestRival: { store: cheapest.store, medianCents: cheapest.medianCents }, gapPercent, signal });
    }
  }
  gaps.sort((a, b) => a.yourCount - b.yourCount || Math.max(...b.rivals.map((r) => r.count)) - Math.max(...a.rivals.map((r) => r.count)));
  pricePositions.sort((a, b) => (a.signal === b.signal ? a.gapPercent - b.gapPercent : a.signal === "above_rival" ? -1 : 1));
  return { gaps, pricePositions };
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

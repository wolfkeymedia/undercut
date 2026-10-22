/** A store we watch, either the merchant's own store or one of its competitors. */
export interface Store {
  id: string;
  name: string;
  /** Origin only, e.g. "https://example.com". */
  url: string;
  kind: "merchant" | "competitor";
}

/** One product as seen on one check. Prices are in minor units (cents) to avoid float drift. */
export interface ProductSnapshot {
  /** Stable key within a store: Shopify product id, SKU, or the product URL. */
  externalId: string;
  title: string;
  url: string;
  vendor?: string;
  productType?: string;
  imageUrl?: string;
  currency?: string;
  /** Cheapest available variant, or cheapest variant if none are available. */
  priceCents: number;
  /** "Was" price shown next to the current price, if any. */
  compareAtCents?: number;
  available: boolean;
  /** Merchant-only: unit cost, used to work out margin in the brief. */
  costCents?: number;
}

export interface Promotion {
  /** Stable key so the same promo seen twice is not reported twice. */
  key: string;
  kind: "percent_off" | "amount_off" | "free_shipping" | "discount_code" | "sale_banner";
  text: string;
  percentOff?: number;
  amountOffCents?: number;
  code?: string;
  /** Free-shipping minimum order. */
  thresholdCents?: number;
}

/** Everything collected from one store on one run. */
export interface StoreObservation {
  storeId: string;
  observedAt: Date;
  products: ProductSnapshot[];
  promotions: Promotion[];
  /** How the products were collected, for debugging extraction quality. */
  source: "shopify_feed" | "structured_data" | "mixed";
}

export type EventKind =
  | "price_drop"
  | "price_increase"
  | "out_of_stock"
  | "back_in_stock"
  | "new_product"
  | "removed_product"
  | "promo_started"
  | "promo_ended";

export interface ChangeEvent {
  storeId: string;
  kind: EventKind;
  occurredAt: Date;
  /** Product events carry the product id; promo events carry the promo key. */
  externalId?: string;
  promoKey?: string;
  title: string;
  url?: string;
  beforeCents?: number;
  afterCents?: number;
  detail?: string;
}

export interface ProductMatch {
  merchantExternalId: string;
  competitorStoreId: string;
  competitorExternalId: string;
  confidence: number;
  status: "suggested" | "confirmed" | "rejected";
}

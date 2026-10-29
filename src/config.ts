import { readFile } from "node:fs/promises";

/** How the merchant wants to price against competitors. Lives in undercut.config.json. */
export interface PricingConfig {
  /** "beat": a little under the cheapest rival; "match": equal to it; "premium": a set percent above it. */
  strategy: "beat" | "match" | "premium";
  /** For "beat": how far under the cheapest rival, in percent. */
  beatByPercent: number;
  /** For "premium": how far above the cheapest rival, in percent. */
  premiumPercent: number;
  /** Never recommend a price below this margin over unit cost. */
  minMarginPercent: number;
  /** Never move a price by more than this in one step, in either direction. */
  maxChangePercent: number;
  /** Ignore recommendations smaller than this, in percent, so prices don't churn. */
  minChangePercent: number;
  /** End recommended prices in .99 (charm pricing) or leave them as computed. */
  rounding: "99" | "none";
}

export interface Config {
  pricing: PricingConfig;
  collect: {
    /**
     * "auto": load a page in a headless browser when its prices only appear after
     * JavaScript runs (needs Playwright's Chromium installed). "never": skip such pages.
     */
    renderJavaScript: "auto" | "never";
  };
  /**
   * Share of a product's weekly sales assumed at risk for each 1% a cheaper rival
   * undercuts you. 2 means a rival 5% cheaper puts 10% of that product's sales at risk.
   * A planning estimate, not a measurement; tune it to your category.
   */
  priceSensitivity: number;
  /** Upper bound on the share of a product's sales counted as at risk. */
  maxShareAtRisk: number;
  alerts: {
    /** Slack incoming webhook or any URL that accepts a JSON POST. */
    webhookUrl?: string;
    /** Only changes ranked at or above this score are sent instantly; the rest wait for the brief. */
    minScore: number;
  };
}

export const DEFAULT_CONFIG: Config = {
  pricing: {
    strategy: "beat",
    beatByPercent: 1,
    premiumPercent: 5,
    minMarginPercent: 25,
    maxChangePercent: 15,
    minChangePercent: 1,
    rounding: "99",
  },
  collect: { renderJavaScript: "auto" },
  priceSensitivity: 2,
  maxShareAtRisk: 0.6,
  alerts: { minScore: 50 },
};

/** Reads undercut.config.json if present, filling anything it leaves out with defaults. */
export async function loadConfig(path = process.env.UNDERCUT_CONFIG ?? "undercut.config.json"): Promise<Config> {
  let file: Partial<Config> & { pricing?: Partial<PricingConfig>; alerts?: Partial<Config["alerts"]>; collect?: Partial<Config["collect"]> } = {};
  try {
    file = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
  return {
    ...DEFAULT_CONFIG,
    ...file,
    pricing: { ...DEFAULT_CONFIG.pricing, ...file.pricing },
    collect: { ...DEFAULT_CONFIG.collect, ...file.collect },
    alerts: {
      ...DEFAULT_CONFIG.alerts,
      ...file.alerts,
      webhookUrl: file.alerts?.webhookUrl ?? process.env.UNDERCUT_ALERT_WEBHOOK ?? undefined,
    },
  };
}

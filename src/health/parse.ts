import * as cheerio from "cheerio";

/**
 * Pure readers for the site health check: they take a page, a sitemap or an API
 * answer and return plain facts. No network here, so each one is easy to test.
 */

// ---------- tracking ----------

export interface TrackingTags {
  /** Meta (Facebook) pixel ids found on the page. */
  metaPixelIds: string[];
  /** The page loads Meta's pixel script (fbevents.js) or Shopify's Facebook pixel. */
  metaScript: boolean;
  /** Google tag ids: G- (Analytics 4), AW- (Ads), GTM- (Tag Manager), UA- (old Analytics). */
  googleIds: string[];
  /** The page loads a Google tag script (gtag.js or gtm.js). */
  googleScript: boolean;
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** Finds Meta pixel and Google tags in a page's HTML, including ones Shopify's pixel manager sets up. */
export function detectTracking(html: string): TrackingTags {
  // Shopify writes its pixel settings as escaped JSON; unescape quotes so one pattern fits both.
  const src = html.replace(/\\"/g, '"').replace(/\\\//g, "/");
  const metaPixelIds = uniq([
    ...[...src.matchAll(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{6,20})['"]/g)].map((m) => m[1]!),
    ...[...src.matchAll(/facebook\.com\/tr\?[^"'\s>]*\bid=(\d{6,20})/g)].map((m) => m[1]!),
    // Shopify's Facebook & Instagram channel: {"type":"APP","apiClientId":...,"configuration":"{\"pixel_id\":\"123\"..."}
    ...[...src.matchAll(/["']?pixel_?[iI]d["']?\s*:\s*["'](\d{6,20})["']/g)].map((m) => m[1]!),
  ]);
  const metaScript = /connect\.facebook\.net\/[^"'\s]*\/fbevents\.js/.test(src) || (metaPixelIds.length > 0 && /web-pixel|webPixelsManager/i.test(src));
  const googleIds = uniq([...src.matchAll(/\b(G-[A-Z0-9]{6,12}|AW-\d{6,12}|GTM-[A-Z0-9]{4,10}|UA-\d{4,10}-\d{1,4})\b/g)].map((m) => m[1]!));
  const googleScript = /googletagmanager\.com\/(gtag\/js|gtm\.js)/.test(src) || (googleIds.length > 0 && /web-pixel|webPixelsManager/i.test(src));
  return { metaPixelIds, metaScript, googleIds, googleScript };
}

// ---------- pages and links ----------

export interface PageFacts {
  title?: string;
  description?: string;
  /** Images with no alt attribute at all (alt="" is a deliberate choice for decoration, so it counts as fine). */
  imagesMissingAlt: number;
  images: number;
  /** The viewport meta tag, as written. */
  viewport?: string;
  /** Same-site links found in the header, nav and footer. */
  navLinks: string[];
  /** Product page links anywhere on the page. */
  productLinks: string[];
}

/** Reads the SEO and mobile basics, and the main links, from a page. */
export function readPage(html: string, pageUrl: string): PageFacts {
  const $ = cheerio.load(html);
  const clean = (s: string | undefined) => s?.replace(/\s+/g, " ").trim() || undefined;
  const imgs = $("body img");
  const origin = new URL(pageUrl).origin;
  const sameSite = (href: string | undefined): string | null => {
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return null;
    try {
      const u = new URL(href, pageUrl);
      if (u.origin !== origin) return null;
      u.hash = "";
      return u.toString();
    } catch {
      return null;
    }
  };
  const links = (selector: string) => uniq($(selector).map((_, a) => sameSite($(a).attr("href"))).get().filter((x): x is string => Boolean(x)));
  return {
    title: clean($("head title").first().text() || $("title").first().text()),
    description: clean($('meta[name="description" i]').attr("content")),
    images: imgs.length,
    imagesMissingAlt: imgs.filter((_, el) => $(el).attr("alt") === undefined).length,
    viewport: clean($('meta[name="viewport" i]').attr("content")),
    navLinks: links("header a[href], nav a[href], footer a[href], [role=navigation] a[href]"),
    productLinks: links('a[href*="/products/"]'),
  };
}

/** A viewport tag that blocks zooming or isn't set for phones. Returns the problem in plain words, or null. */
export function viewportProblem(viewport: string | undefined): string | null {
  if (!viewport) return "The page has no mobile viewport tag, so phones show a shrunk desktop page.";
  const v = viewport.toLowerCase().replace(/\s+/g, "");
  if (!v.includes("width=device-width")) return "The viewport tag doesn't set width=device-width, so phones may show a shrunk page.";
  if (/user-scalable=(no|0)/.test(v) || /maximum-scale=(1|1\.0|0?\.\d+)(,|$)/.test(v)) return "The page stops shoppers zooming in, which makes small text and buttons hard to use.";
  return null;
}

// ---------- sitemap and robots ----------

export interface Sitemap {
  /** Page addresses listed. */
  urls: string[];
  /** Further sitemaps listed (a sitemap index). */
  sitemaps: string[];
}

export function parseSitemap(xml: string): Sitemap {
  const locs = (tag: string) =>
    [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<loc>\\s*(?:<!\\[CDATA\\[)?\\s*([^<\\]]+?)\\s*(?:\\]\\]>)?\\s*</loc>`, "gi"))].map((m) =>
      m[1]!.replace(/&amp;/g, "&"),
    );
  return { urls: uniq(locs("url")), sitemaps: uniq(locs("sitemap")) };
}

/** Sitemap addresses named in robots.txt. */
export function sitemapsInRobots(robots: string): string[] {
  return uniq([...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!));
}

/** True when robots.txt tells every crawler to stay off the whole site. */
export function robotsBlocksAll(robots: string): boolean {
  let star = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const [k, ...rest] = line.split(":");
    const key = k?.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") star = value === "*";
    else if (star && key === "disallow" && value === "/") return true;
  }
  return false;
}

// ---------- PageSpeed Insights ----------

export interface SpeedResult {
  url: string;
  /** Lighthouse performance score, 0 to 100, on a simulated mid-range phone. */
  score?: number;
  /** Lab timings from that test. */
  lab: { lcpMs?: number; cls?: number; tbtMs?: number; fcpMs?: number };
  /** Real shoppers' visits over the last 28 days (Chrome UX Report), when Google has enough of them. */
  field?: { lcpMs?: number; inpMs?: number; cls?: number; verdict?: "FAST" | "AVERAGE" | "SLOW" };
  /** The viewport audit passed. */
  viewportOk?: boolean;
  /** Share of text big enough to read on a phone, if the audit ran. */
  legibleFontOk?: boolean;
  /** Tap targets spaced well enough, if the audit ran (older Lighthouse only). */
  tapTargetsOk?: boolean;
}

/** Reads the parts we use from a PageSpeed Insights v5 answer. */
export function parsePageSpeed(url: string, body: unknown): SpeedResult {
  const b = (body ?? {}) as {
    lighthouseResult?: { categories?: { performance?: { score?: number | null } }; audits?: Record<string, { numericValue?: number; score?: number | null }> };
    loadingExperience?: { overall_category?: string; metrics?: Record<string, { percentile?: number }> };
  };
  const audits = b.lighthouseResult?.audits ?? {};
  const num = (id: string) => (typeof audits[id]?.numericValue === "number" ? audits[id]!.numericValue : undefined);
  const pass = (id: string) => (audits[id] && typeof audits[id]!.score === "number" ? audits[id]!.score! >= 0.9 : undefined);
  const perf = b.lighthouseResult?.categories?.performance?.score;
  const fm = b.loadingExperience?.metrics;
  const fp = (id: string) => (typeof fm?.[id]?.percentile === "number" ? fm[id]!.percentile : undefined);
  const verdict = b.loadingExperience?.overall_category;
  const field = fm
    ? {
        lcpMs: fp("LARGEST_CONTENTFUL_PAINT_MS"),
        inpMs: fp("INTERACTION_TO_NEXT_PAINT"),
        // Reported as layout shift x 100.
        cls: fp("CUMULATIVE_LAYOUT_SHIFT_SCORE") !== undefined ? fp("CUMULATIVE_LAYOUT_SHIFT_SCORE")! / 100 : undefined,
        verdict: verdict === "FAST" || verdict === "AVERAGE" || verdict === "SLOW" ? (verdict as "FAST" | "AVERAGE" | "SLOW") : undefined,
      }
    : undefined;
  return {
    url,
    score: typeof perf === "number" ? Math.round(perf * 100) : undefined,
    lab: { lcpMs: num("largest-contentful-paint"), cls: num("cumulative-layout-shift"), tbtMs: num("total-blocking-time"), fcpMs: num("first-contentful-paint") },
    field: field && Object.values(field).some((v) => v !== undefined) ? field : undefined,
    viewportOk: pass("viewport"),
    legibleFontOk: pass("font-size"),
    tapTargetsOk: pass("tap-targets"),
  };
}

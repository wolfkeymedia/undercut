import { connect } from "node:tls";
import { detectTracking, parsePageSpeed, parseSitemap, readPage, robotsBlocksAll, sitemapsInRobots, viewportProblem, type SpeedResult, type TrackingTags } from "./parse.js";

/**
 * Checks a client's own website: tracking tags, broken pages and redirects,
 * speed and mobile (from Google PageSpeed Insights), SEO basics and HTTPS.
 * The result is plain data saved as-is; findings are worked out when the page is shown.
 */

export interface PageCheck {
  url: string;
  /** Where we found the link. */
  source: "home" | "nav" | "key" | "sitemap";
  status: number;
  /** Addresses passed through before the final one, when the link redirects. */
  redirects: string[];
  finalUrl: string;
  error?: string;
  title?: string;
  description?: string;
  images?: number;
  imagesMissingAlt?: number;
}

export interface TrackedPage {
  label: string;
  url: string;
  status: number;
  tags?: TrackingTags;
}

export interface SiteHealthData {
  site: string;
  checkedAt: string;
  /** Most pages the crawl reads. */
  crawlLimit: number;
  /** The crawl stopped at the time limit before reaching every page it meant to. */
  crawlCutShort?: boolean;
  tracking: {
    pages: TrackedPage[];
    /** Whether the tag scripts themselves answered when we asked for them. */
    metaScriptLoads?: boolean;
    googleScriptLoads?: boolean;
  };
  pages: PageCheck[];
  robots: { status: number; blocksAll: boolean };
  sitemap: { url: string; status: number; urls: number };
  speed: { connected: boolean; results: SpeedResult[]; errors: string[] };
  mobile: { viewportProblem: string | null };
  security: { httpsRedirect?: boolean; httpLandsOn?: string; certExpires?: string; certError?: string };
}

export interface HttpAnswer {
  status: number;
  location?: string;
  body: string;
  contentType: string;
}
/** One request, redirects not followed. Tests pass a fake one. */
export type HealthHttp = (url: string, options?: { timeoutMs?: number }) => Promise<HttpAnswer>;

export interface HealthOptions {
  http?: HealthHttp;
  /** Reads a host's certificate expiry date. */
  certExpiry?: (host: string) => Promise<Date>;
  pageSpeedKey?: string;
  /** Best-selling product page first; the first product link on the site is used when empty. */
  productUrls?: string[];
  maxPages?: number;
  /** Stop crawling at this time (ms since epoch). */
  deadline?: number;
  now?: Date;
}

const USER_AGENT = "UndercutBot/0.1 site health check (+https://github.com/wolfkeymedia/undercut)";
const MAX_HOPS = 6;

export const defaultHttp: HealthHttp = async (url, options = {}) => {
  const res = await fetch(url, {
    headers: { "user-agent": process.env.UNDERCUT_USER_AGENT || USER_AGENT, accept: "text/html,application/xml,application/json;q=0.9,*/*;q=0.8" },
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const type = res.headers.get("content-type") ?? "";
  // Only read bodies we use; skip images, PDFs and the like.
  const body = (res.status < 300 || /json/i.test(type)) && /html|xml|json|text|javascript/i.test(type) ? await res.text() : (await res.body?.cancel(), "");
  return { status: res.status, location: res.headers.get("location") ?? undefined, body, contentType: type };
};

export function defaultCertExpiry(host: string): Promise<Date> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert?.valid_to) reject(new Error("No certificate"));
      else resolve(new Date(cert.valid_to));
    });
    socket.on("timeout", () => socket.destroy(new Error("Timed out")));
    socket.on("error", reject);
  });
}

/** Follows redirects one hop at a time so the chain can be reported. */
export async function follow(http: HealthHttp, url: string): Promise<{ status: number; redirects: string[]; finalUrl: string; answer?: HttpAnswer; error?: string }> {
  const redirects: string[] = [];
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let answer: HttpAnswer;
    try {
      answer = await http(current);
    } catch (err) {
      return { status: 0, redirects, finalUrl: current, error: (err as Error).message };
    }
    if (answer.status >= 300 && answer.status < 400 && answer.location) {
      redirects.push(current);
      current = new URL(answer.location, current).toString();
      if (redirects.includes(current)) return { status: answer.status, redirects, finalUrl: current, error: "Redirect loop" };
      continue;
    }
    return { status: answer.status, redirects, finalUrl: current, answer };
  }
  return { status: 0, redirects, finalUrl: current, error: "Too many redirects" };
}

async function inPool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

export async function checkSiteHealth(siteUrl: string, options: HealthOptions = {}): Promise<SiteHealthData> {
  const http = options.http ?? defaultHttp;
  const maxPages = options.maxPages ?? 100;
  const deadline = options.deadline ?? Date.now() + 200_000;
  const home = new URL(siteUrl.match(/^https?:\/\//) ? siteUrl : `https://${siteUrl}`);
  home.pathname = "/";
  home.search = home.hash = "";
  const origin = home.origin;

  const pages = new Map<string, PageCheck>();
  const htmlByUrl = new Map<string, string>();
  const check = async (url: string, source: PageCheck["source"]) => {
    if (pages.has(url) || pages.size >= maxPages) return;
    const placeholder: PageCheck = { url, source, status: 0, redirects: [], finalUrl: url };
    pages.set(url, placeholder);
    const r = await follow(http, url);
    Object.assign(placeholder, { status: r.status, redirects: r.redirects, finalUrl: r.finalUrl, error: r.error });
    if (r.answer && r.status === 200 && /html/i.test(r.answer.contentType)) {
      htmlByUrl.set(url, r.answer.body);
      const f = readPage(r.answer.body, r.finalUrl);
      Object.assign(placeholder, { title: f.title, description: f.description, images: f.images, imagesMissingAlt: f.imagesMissingAlt });
    }
  };

  // Home page first: it gives the main navigation.
  await check(home.toString(), "home");
  const homeHtml = htmlByUrl.get(home.toString()) ?? "";
  const homeFacts = homeHtml ? readPage(homeHtml, pages.get(home.toString())!.finalUrl) : undefined;

  // robots.txt and the sitemap.
  const robotsAnswer = await follow(http, `${origin}/robots.txt`);
  const robotsBody = robotsAnswer.status === 200 ? robotsAnswer.answer?.body ?? "" : "";
  const sitemapUrl = sitemapsInRobots(robotsBody).find((u) => u.startsWith(origin)) ?? `${origin}/sitemap.xml`;
  const sitemapAnswer = await follow(http, sitemapUrl);
  let sitemapPages: string[] = [];
  if (sitemapAnswer.status === 200 && sitemapAnswer.answer) {
    const top = parseSitemap(sitemapAnswer.answer.body);
    sitemapPages = top.urls;
    // A sitemap index: read a few of its parts, pages and collections before the long product lists.
    const rank = (u: string) => (/page/i.test(u) ? 0 : /collection/i.test(u) ? 1 : /product/i.test(u) ? 2 : 3);
    for (const child of [...top.sitemaps].sort((a, b) => rank(a) - rank(b)).slice(0, 4)) {
      if (Date.now() > deadline) break;
      const c = await follow(http, child);
      if (c.status === 200 && c.answer) sitemapPages.push(...parseSitemap(c.answer.body).urls.slice(0, 60));
    }
  }

  // Key pages for the tracking check.
  const productUrl =
    options.productUrls?.find((u) => u.startsWith(origin)) ?? homeFacts?.productLinks[0] ?? sitemapPages.find((u) => /\/products\//.test(u));
  const collectionUrl = homeFacts?.navLinks.find((u) => /\/collections\/[^/]+$/.test(new URL(u).pathname)) ?? sitemapPages.find((u) => /\/collections\//.test(u));
  const keyPages: { label: string; url: string }[] = [
    { label: "Home page", url: home.toString() },
    ...(collectionUrl ? [{ label: "Collection page", url: collectionUrl }] : []),
    ...(productUrl ? [{ label: "Product page", url: productUrl }] : []),
    { label: "Cart", url: `${origin}/cart` },
  ];

  // Speed runs alongside the crawl, since each test takes Google 10 to 40 seconds.
  const speed = options.pageSpeedKey
    ? runSpeed(http, options.pageSpeedKey, [home.toString(), ...(productUrl ? [productUrl] : [])])
    : Promise.resolve({ connected: false, results: [], errors: [] });

  // Crawl: main navigation and key pages first, then the sitemap, up to the page limit.
  const queue: { url: string; source: PageCheck["source"] }[] = [
    ...keyPages.slice(1).map((k) => ({ url: k.url, source: "key" as const })),
    ...(homeFacts?.navLinks ?? []).map((url) => ({ url, source: "nav" as const })),
    ...sitemapPages.filter((u) => u.startsWith(origin)).map((url) => ({ url, source: "sitemap" as const })),
  ];
  const seen = new Set(pages.keys());
  const todo = queue.filter((q) => !seen.has(q.url) && seen.add(q.url)).slice(0, maxPages - pages.size);
  let cutShort = false;
  await inPool(todo, 4, async (q) => {
    if (Date.now() > deadline) {
      cutShort = true;
      return;
    }
    await check(q.url, q.source);
  });

  // Tracking on the key pages, and whether the tag scripts load.
  const trackedPages: TrackedPage[] = keyPages.map((k) => {
    const html = htmlByUrl.get(k.url);
    return { label: k.label, url: k.url, status: pages.get(k.url)?.status ?? 0, tags: html ? detectTracking(html) : undefined };
  });
  const anyTags = trackedPages.map((p) => p.tags).filter((t): t is TrackingTags => Boolean(t));
  const scriptLoads = async (url: string) => {
    try {
      return (await follow(http, url)).status === 200;
    } catch {
      return false;
    }
  };
  const googleId = anyTags.flatMap((t) => t.googleIds).find((id) => !id.startsWith("UA-"));
  const metaScriptLoads = anyTags.some((t) => t.metaScript || t.metaPixelIds.length) ? await scriptLoads("https://connect.facebook.net/en_US/fbevents.js") : undefined;
  const googleScriptLoads = googleId
    ? await scriptLoads(googleId.startsWith("GTM-") ? `https://www.googletagmanager.com/gtm.js?id=${googleId}` : `https://www.googletagmanager.com/gtag/js?id=${googleId}`)
    : undefined;

  // HTTPS: plain http should send shoppers to https; and when does the certificate run out?
  const security: SiteHealthData["security"] = {};
  const plain = await follow(http, `http://${home.host}/`);
  if (plain.status || plain.redirects.length) {
    security.httpLandsOn = plain.finalUrl;
    security.httpsRedirect = plain.redirects.length > 0 && plain.finalUrl.startsWith("https://");
  }
  try {
    security.certExpires = (await (options.certExpiry ?? defaultCertExpiry)(home.hostname)).toISOString();
  } catch (err) {
    security.certError = (err as Error).message;
  }

  return {
    site: origin,
    checkedAt: (options.now ?? new Date()).toISOString(),
    crawlLimit: maxPages,
    crawlCutShort: cutShort || undefined,
    tracking: { pages: trackedPages, metaScriptLoads, googleScriptLoads },
    pages: [...pages.values()],
    robots: { status: robotsAnswer.status, blocksAll: robotsBlocksAll(robotsBody) },
    sitemap: { url: sitemapUrl, status: sitemapAnswer.status, urls: sitemapPages.length },
    speed: await speed,
    mobile: { viewportProblem: homeHtml ? viewportProblem(homeFacts?.viewport) : null },
    security,
  };
}

async function runSpeed(http: HealthHttp, key: string, urls: string[]): Promise<SiteHealthData["speed"]> {
  const results: SpeedResult[] = [];
  const errors: string[] = [];
  await Promise.all(
    urls.map(async (url) => {
      const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${new URLSearchParams({ url, strategy: "mobile", category: "performance", key })}`;
      try {
        const res = await http(api, { timeoutMs: 90_000 });
        if (res.status !== 200) {
          let reason = `HTTP ${res.status}`;
          try {
            reason = (JSON.parse(res.body) as { error?: { message?: string } }).error?.message ?? reason;
          } catch {}
          errors.push(`${url}: ${reason}`);
          return;
        }
        results.push(parsePageSpeed(url, JSON.parse(res.body)));
      } catch (err) {
        errors.push(`${url}: ${(err as Error).message}`);
      }
    }),
  );
  results.sort((a, b) => urls.indexOf(a.url) - urls.indexOf(b.url));
  return { connected: true, results, errors };
}

import { describe, expect, it } from "vitest";
import { checkSiteHealth, follow, type HealthHttp, type HttpAnswer, type SiteHealthData } from "../src/health/check.js";
import { detectTracking, parsePageSpeed, parseSitemap, readPage, robotsBlocksAll, sitemapsInRobots, viewportProblem } from "../src/health/parse.js";
import { assessHealth, healthScore } from "../src/health/score.js";
import { healthTeaser, renderHealth } from "../src/report/health.js";

describe("tracking detection", () => {
  it("finds a hand-added Meta pixel and gtag", () => {
    const t = detectTracking(`<script>!function(f,b,e,v){}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
      fbq('init', '123456789012345'); fbq('track', 'PageView');</script>
      <noscript><img src="https://www.facebook.com/tr?id=123456789012345&ev=PageView&noscript=1"></noscript>
      <script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ9"></script><script>gtag('config','G-ABC123XYZ9');gtag('config','AW-987654321');</script>`);
    expect(t).toEqual({ metaPixelIds: ["123456789012345"], metaScript: true, googleIds: ["G-ABC123XYZ9", "AW-987654321"], googleScript: true });
  });

  it("finds tags Shopify's pixel manager sets up in escaped JSON", () => {
    const t = detectTracking(
      `<script id="web-pixels-manager-setup">(function(){window.webPixelsManager={};var c={"webPixelsConfigList":[{"id":"1","configuration":"{\\"pixel_id\\":\\"998877665544\\",\\"pixel_type\\":\\"facebook_pixel\\"}","type":"APP"},{"id":"2","configuration":"{\\"config\\":\\"{\\\\\\"google_tag_ids\\\\\\":[\\\\\\"G-SHOP12345\\\\\\"]}\\"}"}]}})();</script>`,
    );
    expect(t.metaPixelIds).toEqual(["998877665544"]);
    expect(t.metaScript).toBe(true);
    expect(t.googleIds).toEqual(["G-SHOP12345"]);
    expect(t.googleScript).toBe(true);
  });

  it("reports nothing on a page without tags", () => {
    expect(detectTracking("<html><body>Hello</body></html>")).toEqual({ metaPixelIds: [], metaScript: false, googleIds: [], googleScript: false });
  });
});

describe("page reading", () => {
  const html = `<html><head><title> Glow Serum
    | SOSU </title><meta name="description" content="A serum."><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body><header><nav><a href="/collections/face">Face</a><a href="https://other.example/x">Away</a><a href="#top">Top</a><a href="mailto:a@b.c">Mail</a></nav></header>
    <img src="a.jpg"><img src="b.jpg" alt=""><img src="c.jpg" alt="Serum bottle"><a href="/products/glow-serum#reviews">Glow</a>
    <footer><a href="/pages/contact">Contact</a></footer></body></html>`;

  it("reads title, description, alt text, viewport and links", () => {
    const f = readPage(html, "https://shop.example/");
    expect(f.title).toBe("Glow Serum | SOSU");
    expect(f.description).toBe("A serum.");
    expect(f.images).toBe(3);
    expect(f.imagesMissingAlt).toBe(1);
    expect(f.viewport).toBe("width=device-width, initial-scale=1");
    expect(f.navLinks).toEqual(["https://shop.example/collections/face", "https://shop.example/pages/contact"]);
    expect(f.productLinks).toEqual(["https://shop.example/products/glow-serum"]);
  });

  it("explains viewport problems in plain words", () => {
    expect(viewportProblem("width=device-width, initial-scale=1")).toBeNull();
    expect(viewportProblem(undefined)).toMatch(/no mobile viewport/);
    expect(viewportProblem("width=1024")).toMatch(/device-width/);
    expect(viewportProblem("width=device-width, user-scalable=no")).toMatch(/zoom/);
    expect(viewportProblem("width=device-width, maximum-scale=1")).toMatch(/zoom/);
    expect(viewportProblem("width=device-width, maximum-scale=5")).toBeNull();
  });
});

describe("sitemap and robots", () => {
  it("reads page lists and sitemap indexes", () => {
    expect(parseSitemap(`<urlset><url><loc>https://s.example/a?x=1&amp;y=2</loc></url><url><loc> <![CDATA[https://s.example/b]]> </loc><lastmod>2026</lastmod></url></urlset>`)).toEqual({
      urls: ["https://s.example/a?x=1&y=2", "https://s.example/b"],
      sitemaps: [],
    });
    expect(parseSitemap(`<sitemapindex><sitemap><loc>https://s.example/sitemap_products_1.xml</loc></sitemap></sitemapindex>`).sitemaps).toEqual([
      "https://s.example/sitemap_products_1.xml",
    ]);
  });

  it("finds sitemaps in robots.txt and spots a site-wide block", () => {
    const robots = "User-agent: *\nDisallow: /cart\nSitemap: https://s.example/sitemap.xml\n";
    expect(sitemapsInRobots(robots)).toEqual(["https://s.example/sitemap.xml"]);
    expect(robotsBlocksAll(robots)).toBe(false);
    expect(robotsBlocksAll("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow:\n")).toBe(false);
    expect(robotsBlocksAll("User-agent: *\nDisallow: / # building\n")).toBe(true);
  });
});

describe("PageSpeed Insights", () => {
  it("reads the score, lab timings, field data and mobile audits", () => {
    const r = parsePageSpeed("https://s.example/", {
      lighthouseResult: {
        categories: { performance: { score: 0.42 } },
        audits: {
          "largest-contentful-paint": { numericValue: 5210 },
          "cumulative-layout-shift": { numericValue: 0.03 },
          "total-blocking-time": { numericValue: 640 },
          viewport: { score: 1 },
          "font-size": { score: 0 },
        },
      },
      loadingExperience: {
        overall_category: "SLOW",
        metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4100 }, INTERACTION_TO_NEXT_PAINT: { percentile: 310 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12 } },
      },
    });
    expect(r).toEqual({
      url: "https://s.example/",
      score: 42,
      lab: { lcpMs: 5210, cls: 0.03, tbtMs: 640, fcpMs: undefined },
      field: { lcpMs: 4100, inpMs: 310, cls: 0.12, verdict: "SLOW" },
      viewportOk: true,
      legibleFontOk: false,
      tapTargetsOk: undefined,
    });
  });

  it("copes with an empty answer", () => {
    expect(parsePageSpeed("https://s.example/", {})).toMatchObject({ score: undefined, field: undefined });
  });
});

// ---------- scoring ----------

function baseData(over: Partial<SiteHealthData> = {}): SiteHealthData {
  const tags = { metaPixelIds: ["111111"], metaScript: true, googleIds: ["G-AAAAAA1"], googleScript: true };
  return {
    site: "https://s.example",
    checkedAt: "2026-11-22T06:00:00.000Z",
    crawlLimit: 100,
    tracking: {
      pages: [
        { label: "Home page", url: "https://s.example/", status: 200, tags },
        { label: "Product page", url: "https://s.example/products/a", status: 200, tags },
      ],
      metaScriptLoads: true,
      googleScriptLoads: true,
    },
    pages: [
      { url: "https://s.example/", source: "home", status: 200, redirects: [], finalUrl: "https://s.example/", title: "Home", description: "Shop", images: 2, imagesMissingAlt: 0 },
      { url: "https://s.example/products/a", source: "key", status: 200, redirects: [], finalUrl: "https://s.example/products/a", title: "A", description: "About A", images: 1, imagesMissingAlt: 0 },
    ],
    robots: { status: 200, blocksAll: false },
    sitemap: { url: "https://s.example/sitemap.xml", status: 200, urls: 2 },
    speed: { connected: false, results: [], errors: [] },
    mobile: { viewportProblem: null },
    security: { httpsRedirect: true, certExpires: "2027-03-01T00:00:00.000Z" },
    ...over,
  };
}
const now = new Date("2026-11-22T08:00:00Z");

describe("site health scoring", () => {
  it("scores a clean site 100 and shows speed as not connected", () => {
    const r = assessHealth(baseData(), now);
    expect(r.findings).toEqual([]);
    expect(r.score).toBe(100);
    expect(r.areas.find((a) => a.area === "speed")).toMatchObject({ status: "off", line: "Not connected yet." });
    expect(r.areas.find((a) => a.area === "security")!.line).toMatch(/1 Mar 2027/);
  });

  it("weighs findings by priority", () => {
    expect(healthScore([{ priority: "high" }, { priority: "medium" }, { priority: "low" }])).toBe(77);
    expect(healthScore(Array.from({ length: 10 }, () => ({ priority: "high" as const })))).toBe(0);
  });

  it("flags a pixel missing from some key pages first", () => {
    const d = baseData();
    d.tracking.pages[1]!.tags = { metaPixelIds: [], metaScript: false, googleIds: ["G-AAAAAA1"], googleScript: true };
    const r = assessHealth(d, now);
    expect(r.findings[0]).toMatchObject({ area: "tracking", priority: "high", examples: ["https://s.example/products/a"] });
    expect(r.findings[0]!.issue).toMatch(/Meta \(Facebook\) pixel is on your home page but missing from your product page/);
  });

  it("says when no tag is found at all, and when a script won't load", () => {
    const d = baseData({ tracking: { pages: [{ label: "Home page", url: "https://s.example/", status: 200, tags: { metaPixelIds: [], metaScript: false, googleIds: ["G-X1Y2Z3A"], googleScript: true } }], googleScriptLoads: false } });
    const issues = assessHealth(d, now).findings.map((f) => `${f.priority}: ${f.issue}`);
    expect(issues).toContain("medium: We couldn't find a Meta (Facebook) pixel on your key pages.");
    expect(issues.some((i) => i.startsWith("high: Your pages mention the Google tag, but its script didn't load"))).toBe(true);
  });

  it("finds broken links, redirect chains and menu redirects", () => {
    const d = baseData();
    d.pages.push(
      { url: "https://s.example/collections/old", source: "nav", status: 404, redirects: [], finalUrl: "https://s.example/collections/old" },
      { url: "https://s.example/products/gone", source: "sitemap", status: 404, redirects: [], finalUrl: "https://s.example/products/gone" },
      { url: "https://s.example/a", source: "sitemap", status: 200, redirects: ["https://s.example/a", "https://s.example/b"], finalUrl: "https://s.example/c", title: "C", description: "c", images: 0, imagesMissingAlt: 0 },
      { url: "https://s.example/sale", source: "nav", status: 200, redirects: ["https://s.example/sale"], finalUrl: "https://s.example/collections/sale", title: "Sale", description: "s", images: 0, imagesMissingAlt: 0 },
    );
    const f = assessHealth(d, now).findings.filter((x) => x.area === "pages");
    expect(f.map((x) => x.priority)).toEqual(["high", "medium", "medium", "low"]);
    expect(f[0]!.examples).toEqual(["/collections/old (404)"]);
    expect(f[2]!.examples).toEqual(["/a → /c (2 hops)"]);
    expect(f[3]!.issue).toMatch(/1 menu link points at an old address/);
  });

  it("doesn't call a missing /cart on a non-shop site broken", () => {
    const d = baseData();
    d.pages.push({ url: "https://s.example/cart", source: "key", status: 404, redirects: [], finalUrl: "https://s.example/cart" });
    expect(assessHealth(d, now).findings).toEqual([]);
  });

  it("covers SEO basics", () => {
    const d = baseData({ robots: { status: 200, blocksAll: true }, sitemap: { url: "https://s.example/sitemap.xml", status: 404, urls: 0 } });
    d.pages[0]!.description = undefined;
    d.pages[1]!.title = "Home";
    d.pages[1]!.imagesMissingAlt = 25;
    const f = assessHealth(d, now).findings.filter((x) => x.area === "seo");
    const by = (re: RegExp) => f.find((x) => re.test(x.issue));
    expect(by(/robots\.txt tells search engines/)?.priority).toBe("high");
    expect(by(/sitemap/)?.priority).toBe("medium");
    expect(by(/no meta description, including your home page/)?.priority).toBe("medium");
    expect(by(/1 title is used on more than one page/)?.priority).toBe("low");
    expect(by(/25 images on 1 page have no alt text/)?.priority).toBe("medium");
  });

  it("turns PageSpeed figures into speed and mobile findings", () => {
    const d = baseData({
      speed: {
        connected: true,
        results: [
          { url: "https://s.example/", score: 38, lab: { lcpMs: 5200, cls: 0.02 }, viewportOk: true, legibleFontOk: false },
          { url: "https://s.example/products/a", score: 95, lab: { lcpMs: 1800, cls: 0.3 }, field: { inpMs: 260 } },
        ],
        errors: [],
      },
    });
    const f = assessHealth(d, now).findings;
    expect(f.find((x) => x.area === "speed" && /home page is slow/.test(x.issue))).toMatchObject({ priority: "high" });
    expect(f.find((x) => /jumps around/.test(x.issue))).toMatchObject({ priority: "high" });
    expect(f.find((x) => /slow to respond to taps/.test(x.issue))).toMatchObject({ priority: "medium" });
    expect(f.find((x) => x.area === "mobile")).toMatchObject({ priority: "medium", issue: "Some text is too small to read on a phone." });
    expect(assessHealth(d, now).areas.find((a) => a.area === "speed")!.line).toBe("Phone speed score: 38/100, 95/100.");
  });

  it("checks the https redirect and certificate dates", () => {
    const soon = baseData({ security: { httpsRedirect: false, certExpires: "2026-11-30T00:00:00.000Z" } });
    expect(assessHealth(soon, now).findings.map((f) => `${f.priority} ${f.area}`)).toEqual(["high security", "high security"]);
    const month = baseData({ security: { httpsRedirect: true, certExpires: "2026-12-12T00:00:00.000Z" } });
    expect(assessHealth(month, now).findings[0]).toMatchObject({ priority: "medium", issue: "Your security certificate runs out on 12 Dec 2026." });
  });
});

// ---------- the crawl ----------

function fakeHttp(routes: Record<string, Partial<HttpAnswer> | string>): HealthHttp & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) return { status: 404, body: "", contentType: "text/html" };
    if (typeof r === "string") return { status: 200, body: r, contentType: r.startsWith("<?xml") || r.startsWith("<urlset") || r.startsWith("<sitemapindex") ? "application/xml" : r.startsWith("{") ? "application/json" : "text/html" };
    return { status: 200, body: "", contentType: "text/html", ...r };
  }) as HealthHttp & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("site health check", () => {
  it("follows redirects hop by hop", async () => {
    const http = fakeHttp({
      "https://s.example/a": { status: 301, location: "/b" },
      "https://s.example/b": { status: 302, location: "https://s.example/c" },
      "https://s.example/c": "<html></html>",
      "https://s.example/loop": { status: 301, location: "/loop" },
    });
    expect(await follow(http, "https://s.example/a")).toMatchObject({ status: 200, redirects: ["https://s.example/a", "https://s.example/b"], finalUrl: "https://s.example/c" });
    expect((await follow(http, "https://s.example/loop")).error).toBe("Redirect loop");
  });

  it("crawls the menu and sitemap, checks tags, speed and https", async () => {
    const tagged = `<script src="https://connect.facebook.net/en_US/fbevents.js"></script><script>fbq('init','5550001112')</script><script src="https://www.googletagmanager.com/gtag/js?id=G-TEST12345"></script>`;
    const http = fakeHttp({
      "https://s.example/": `<html><head><title>S</title><meta name="description" content="Shop"><meta name="viewport" content="width=device-width"></head><body>${tagged}<nav><a href="/collections/face">Face</a><a href="/old">Old</a></nav><a href="/products/serum">Serum</a></body></html>`,
      "https://s.example/collections/face": `<html><head><title>Face</title></head><body>${tagged}</body></html>`,
      "https://s.example/products/serum": `<html><head><title>Serum</title></head><body><img src="x.jpg"></body></html>`,
      "https://s.example/cart": `<html><head><title>Cart</title></head><body>${tagged}</body></html>`,
      "https://s.example/robots.txt": { body: "User-agent: *\nSitemap: https://s.example/sitemap.xml", contentType: "text/plain" },
      "https://s.example/sitemap.xml": `<sitemapindex><sitemap><loc>https://s.example/sitemap_pages_1.xml</loc></sitemap></sitemapindex>`,
      "https://s.example/sitemap_pages_1.xml": `<urlset><url><loc>https://s.example/pages/about</loc></url><url><loc>https://s.example/pages/gone</loc></url></urlset>`,
      "https://s.example/pages/about": `<html><head><title>About</title></head><body></body></html>`,
      "http://s.example/": { status: 301, location: "https://s.example/" },
      "https://connect.facebook.net/en_US/fbevents.js": { body: "", contentType: "application/javascript" },
      "https://www.googletagmanager.com/gtag/js?id=G-TEST12345": { body: "", contentType: "application/javascript" },
    });
    const psi = (score: number) => JSON.stringify({ lighthouseResult: { categories: { performance: { score } }, audits: { "largest-contentful-paint": { numericValue: 3000 } } } });
    const withPsi: HealthHttp = async (url, o) => {
      if (url.startsWith("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?")) {
        const target = new URL(url).searchParams.get("url");
        expect(new URL(url).searchParams.get("key")).toBe("k");
        return { status: 200, body: target === "https://s.example/" ? psi(0.7) : psi(0.5), contentType: "application/json" };
      }
      return http(url, o);
    };
    const data = await checkSiteHealth("s.example", { http: withPsi, certExpiry: async () => new Date("2027-01-01T00:00:00Z"), pageSpeedKey: "k", now });

    expect(data.site).toBe("https://s.example");
    expect(data.tracking.pages.map((p) => [p.label, p.tags?.metaPixelIds.length ?? null])).toEqual([
      ["Home page", 1],
      ["Collection page", 1],
      ["Product page", 0],
      ["Cart", 1],
    ]);
    expect(data.tracking).toMatchObject({ metaScriptLoads: true, googleScriptLoads: true });
    expect(data.pages.find((p) => p.url === "https://s.example/old")).toMatchObject({ source: "nav", status: 404 });
    expect(data.pages.find((p) => p.url === "https://s.example/pages/gone")).toMatchObject({ source: "sitemap", status: 404 });
    expect(data.sitemap).toMatchObject({ status: 200, urls: 2 });
    expect(data.speed.results.map((r) => [r.url, r.score])).toEqual([
      ["https://s.example/", 70],
      ["https://s.example/products/serum", 50],
    ]);
    expect(data.security).toEqual({ httpsRedirect: true, httpLandsOn: "https://s.example/", certExpires: "2027-01-01T00:00:00.000Z" });

    const report = assessHealth(data, now);
    expect(report.findings.filter((f) => f.priority === "high").map((f) => f.issue)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Meta \(Facebook\) pixel is on your .* but missing from your product page/), expect.stringMatching(/1 link in your menu/)]),
    );

    const page = renderHealth({ clientName: "S", data, now });
    expect(page).toContain("Things to fix");
    expect(page).toContain("Fix first");
    expect(page).toContain("doesn't show whether events");
    expect(healthTeaser(data, "/r/x/health", now)).toContain(`Site health ${report.score}/100`);
  });

  it("stops at the page limit and leaves speed not connected without a key", async () => {
    const links = Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">p</a>`).join("");
    const http = fakeHttp({ "https://s.example/": `<html><head><title>S</title></head><body><nav>${links}</nav></body></html>` });
    const data = await checkSiteHealth("https://s.example/shop?x=1", { http, certExpiry: async () => new Date("2027-01-01"), maxPages: 10, now });
    expect(data.pages).toHaveLength(10);
    expect(data.speed).toEqual({ connected: false, results: [], errors: [] });
    expect(http.calls.some((u) => u.includes("pagespeedonline"))).toBe(false);
    expect(renderHealth({ clientName: "S", data, now })).toContain("Not connected");
  });
});

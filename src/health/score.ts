import type { PageCheck, SiteHealthData } from "./check.js";
import type { SpeedResult } from "./parse.js";

/** Turns a saved site health check into plain-language findings, a status per area and an overall score. */

export type Area = "tracking" | "pages" | "speed" | "mobile" | "seo" | "security";
export type Priority = "high" | "medium" | "low";

export interface Finding {
  area: Area;
  priority: Priority;
  issue: string;
  fix: string;
  /** A few of the addresses affected, for the "where" list on the card. */
  examples?: string[];
}

export interface AreaStatus {
  area: Area;
  label: string;
  status: "good" | "warn" | "bad" | "off";
  line: string;
}

export interface HealthReport {
  score: number;
  findings: Finding[];
  areas: AreaStatus[];
}

export const AREA_LABEL: Record<Area, string> = {
  tracking: "Tracking",
  pages: "Broken pages",
  speed: "Speed",
  mobile: "Mobile",
  seo: "SEO basics",
  security: "Security",
};

const WEIGHT: Record<Priority, number> = { high: 15, medium: 6, low: 2 };
const ORDER: Priority[] = ["high", "medium", "low"];
const DAY = 86_400_000;

/** 100 with nothing to fix; each finding takes off points by priority. */
export function healthScore(findings: Pick<Finding, "priority">[]): number {
  return Math.max(0, 100 - findings.reduce((sum, f) => sum + WEIGHT[f.priority], 0));
}

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const path = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search || "/";
  } catch {
    return url;
  }
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export function assessHealth(data: SiteHealthData, now = new Date()): HealthReport {
  const findings = [...tracking(data), ...brokenPages(data), ...speed(data), ...mobile(data), ...seo(data), ...security(data, now)].sort(
    (a, b) => ORDER.indexOf(a.priority) - ORDER.indexOf(b.priority),
  );
  const areas = (Object.keys(AREA_LABEL) as Area[]).map((area) => areaStatus(area, data, findings.filter((f) => f.area === area)));
  return { score: healthScore(findings), findings, areas };
}

function areaStatus(area: Area, data: SiteHealthData, mine: Finding[]): AreaStatus {
  const label = AREA_LABEL[area];
  if (area === "speed" && !data.speed.connected) return { area, label, status: "off", line: "Not connected yet." };
  const status = mine.some((f) => f.priority === "high") ? "bad" : mine.length ? "warn" : "good";
  const fine: Record<Area, string> = {
    tracking: "Meta pixel and Google tag found on every key page.",
    pages: `No broken pages or redirect chains in the ${plural(data.pages.length, "page")} we checked.`,
    speed: speedLine(data.speed.results) ?? "Fast enough on phones.",
    mobile: "Set up properly for phones.",
    seo: "Titles, descriptions, image text, sitemap and robots.txt all in order.",
    security: `Secure connection. ${certLine(data) ?? ""}`.trim(),
  };
  const line = status === "good" ? fine[area] : area === "speed" ? speedLine(data.speed.results) ?? `${plural(mine.length, "thing")} to fix.` : `${plural(mine.length, "thing")} to fix.`;
  return { area, label, status, line };
}

function speedLine(results: SpeedResult[]): string | undefined {
  const scored = results.filter((r) => r.score !== undefined);
  return scored.length ? `Phone speed score: ${scored.map((r) => `${r.score}/100`).join(", ")}.` : undefined;
}

// ---------- tracking ----------

function tracking(data: SiteHealthData): Finding[] {
  const out: Finding[] = [];
  const loaded = data.tracking.pages.filter((p) => p.tags);
  if (loaded.length === 0) return out;
  const tags = [
    {
      name: "Meta (Facebook) pixel",
      has: (p: (typeof loaded)[number]) => p.tags!.metaScript || p.tags!.metaPixelIds.length > 0,
      ids: loaded.flatMap((p) => p.tags!.metaPixelIds),
      loads: data.tracking.metaScriptLoads,
      none: "If you run Facebook or Instagram ads, add your pixel through Shopify's Facebook & Instagram app (or your platform's equivalent) so sales are credited to your ads.",
    },
    {
      name: "Google tag",
      has: (p: (typeof loaded)[number]) => p.tags!.googleScript || p.tags!.googleIds.length > 0,
      ids: loaded.flatMap((p) => p.tags!.googleIds),
      loads: data.tracking.googleScriptLoads,
      none: "Add Google Analytics 4 (and your Google Ads tag if you advertise) through Shopify's Google & YouTube app, so you can see where visitors come from.",
    },
  ];
  for (const t of tags) {
    const on = loaded.filter(t.has);
    if (on.length === 0) {
      out.push({ area: "tracking", priority: "medium", issue: `We couldn't find a ${t.name} on your key pages.`, fix: t.none });
      continue;
    }
    const missing = loaded.filter((p) => !t.has(p));
    if (missing.length > 0) {
      out.push({
        area: "tracking",
        priority: "high",
        issue: `The ${t.name} is on your ${list(on.map((p) => p.label.toLowerCase()))} but missing from your ${list(missing.map((p) => p.label.toLowerCase()))}.`,
        fix: "Set the tag up site-wide (in the theme or the platform's app), not on single pages, so every visit and sale is counted.",
        examples: missing.map((p) => p.url),
      });
    }
    if (t.loads === false) {
      out.push({
        area: "tracking",
        priority: "high",
        issue: `Your pages mention the ${t.name}, but its script didn't load when we asked for it.`,
        fix: "Check the tag's ID in your tracking app, and that nothing (a cookie banner or a theme edit) blocks it.",
      });
    }
    const ids = [...new Set(t.ids.filter((id) => !id.startsWith("GTM-")))];
    if (t.name.startsWith("Meta") && ids.length > 1) {
      out.push({
        area: "tracking",
        priority: "low",
        issue: `There are ${ids.length} different Meta pixels on your site (${ids.join(", ")}).`,
        fix: "If one is old, remove it; two pixels can count the same sale twice or split your ad data.",
      });
    }
    if (t.name === "Google tag" && ids.some((id) => id.startsWith("UA-")) && !ids.some((id) => id.startsWith("G-"))) {
      out.push({
        area: "tracking",
        priority: "medium",
        issue: "Your site only has the old Universal Analytics tag, which Google switched off in 2024.",
        fix: "Set up Google Analytics 4 and add its G- tag through Shopify's Google & YouTube app.",
      });
    }
  }
  return out;
}

// ---------- broken pages and redirects ----------

const isBroken = (p: PageCheck) => p.status === 404 || p.status === 410 || p.status >= 500 || (p.status === 0 && Boolean(p.error));
const isMain = (p: PageCheck) => p.source !== "sitemap";

function brokenPages(data: SiteHealthData): Finding[] {
  const out: Finding[] = [];
  const broken = data.pages.filter(isBroken);
  const mainBroken = broken.filter(isMain).filter((p) => !/\/cart$/.test(new URL(p.url).pathname) || p.status !== 404);
  const mapBroken = broken.filter((p) => !isMain(p));
  if (mainBroken.length)
    out.push({
      area: "pages",
      priority: "high",
      issue: `${plural(mainBroken.length, "link")} in your menu or on key pages ${mainBroken.length === 1 ? "leads" : "lead"} to a missing or failing page.`,
      fix: "Point these links at a live page, or set up a redirect from the old address to the closest live one.",
      examples: mainBroken.map((p) => `${path(p.url)} (${p.status || p.error})`),
    });
  if (mapBroken.length)
    out.push({
      area: "pages",
      priority: "medium",
      issue: `${plural(mapBroken.length, "page")} listed in your sitemap ${mapBroken.length === 1 ? "is" : "are"} missing or failing.`,
      fix: "Remove deleted products and pages from sale properly (or redirect them), so Google stops sending visitors to dead ends.",
      examples: mapBroken.map((p) => `${path(p.url)} (${p.status || p.error})`),
    });
  const chains = data.pages.filter((p) => p.redirects.length >= 2 && !isBroken(p));
  if (chains.length)
    out.push({
      area: "pages",
      priority: "medium",
      issue: `${plural(chains.length, "link")} ${chains.length === 1 ? "goes" : "go"} through two or more redirects before reaching the page.`,
      fix: "Change each link (and the first redirect) to point straight at the final address. Every extra hop slows the page and loses some search value.",
      examples: chains.map((p) => `${path(p.url)} → ${path(p.finalUrl)} (${p.redirects.length} hops)`),
    });
  const menuRedirects = data.pages.filter((p) => p.source === "nav" && p.redirects.length === 1 && !isBroken(p) && new URL(p.finalUrl).origin === data.site);
  if (menuRedirects.length)
    out.push({
      area: "pages",
      priority: "low",
      issue: `${plural(menuRedirects.length, "menu link")} ${menuRedirects.length === 1 ? "points" : "point"} at an old address that redirects.`,
      fix: "Update the menu to use the final address, so shoppers skip the extra hop.",
      examples: menuRedirects.map((p) => `${path(p.url)} → ${path(p.finalUrl)}`),
    });
  const mapRedirects = data.pages.filter((p) => p.source === "sitemap" && p.redirects.length === 1 && !isBroken(p));
  if (mapRedirects.length)
    out.push({
      area: "pages",
      priority: "low",
      issue: `${plural(mapRedirects.length, "address")} in your sitemap ${mapRedirects.length === 1 ? "redirects" : "redirect"} elsewhere.`,
      fix: "A sitemap should list only final addresses. On Shopify this usually clears itself; elsewhere, regenerate the sitemap.",
      examples: mapRedirects.map((p) => `${path(p.url)} → ${path(p.finalUrl)}`),
    });
  return out;
}

// ---------- speed ----------

function speed(data: SiteHealthData): Finding[] {
  if (!data.speed.connected) return [];
  const out: Finding[] = [];
  const name = (url: string) => (path(url) === "/" ? "Your home page" : "Your top product page");
  for (const r of data.speed.results) {
    const lcp = r.field?.lcpMs ?? r.lab.lcpMs;
    if (r.score !== undefined && (r.score < 90 || (lcp !== undefined && lcp > 2500))) {
      const slow = r.score < 50 || (lcp !== undefined && lcp > 4000);
      out.push({
        area: "speed",
        priority: slow ? "high" : "medium",
        issue: `${name(r.url)} is ${slow ? "slow" : "a little slow"} on phones: speed score ${r.score}/100${lcp !== undefined ? `, main content shows after ${seconds(lcp)}` : ""}.`,
        fix: "Shrink large images (use WebP and the platform's image sizes), remove apps you no longer use, and delay chat widgets and pop-ups until the page has loaded. Aim for under 2.5 s.",
        examples: [r.url],
      });
    }
    const cls = r.field?.cls ?? r.lab.cls;
    if (cls !== undefined && cls > 0.1)
      out.push({
        area: "speed",
        priority: cls > 0.25 ? "high" : "medium",
        issue: `${name(r.url)} jumps around while it loads (layout shift ${cls.toFixed(2)}), so shoppers tap the wrong thing.`,
        fix: "Give images and banners a fixed width and height, and reserve space for anything that appears late, such as review stars or cookie bars.",
        examples: [r.url],
      });
    const inp = r.field?.inpMs;
    if (inp !== undefined && inp > 200)
      out.push({
        area: "speed",
        priority: inp > 500 ? "high" : "medium",
        issue: `${name(r.url)} is slow to respond to taps for real visitors (${Math.round(inp)} ms).`,
        fix: "Cut heavy scripts and apps that run on every tap; your developer can find the worst ones in Chrome's performance panel. Aim for under 200 ms.",
        examples: [r.url],
      });
  }
  for (const e of data.speed.errors)
    out.push({ area: "speed", priority: "low", issue: `Google couldn't test the speed of ${e.split(": ")[0]}.`, fix: "Nothing to do now; we'll try again on the next check.", examples: [e] });
  return out;
}

// ---------- mobile ----------

function mobile(data: SiteHealthData): Finding[] {
  const out: Finding[] = [];
  const viewportBad = data.mobile.viewportProblem ?? (data.speed.results.some((r) => r.viewportOk === false) ? "Google's phone test says the page isn't set up for mobile screens." : null);
  if (viewportBad)
    out.push({ area: "mobile", priority: "high", issue: viewportBad, fix: 'Your theme\'s head should include <meta name="viewport" content="width=device-width, initial-scale=1">, without blocking zoom.' });
  if (data.speed.results.some((r) => r.legibleFontOk === false))
    out.push({ area: "mobile", priority: "medium", issue: "Some text is too small to read on a phone.", fix: "Use at least 16px for body text and 12px for small print in the theme settings." });
  if (data.speed.results.some((r) => r.tapTargetsOk === false))
    out.push({ area: "mobile", priority: "medium", issue: "Some buttons and links are too small or too close together to tap easily.", fix: "Make tap areas at least 48px square with space between them, especially in the menu and on product options." });
  return out;
}

// ---------- SEO ----------

function seo(data: SiteHealthData): Finding[] {
  const out: Finding[] = [];
  // Pages we read as HTML; the cart is left out, as it's usually hidden from search anyway.
  const pages = dedupeByFinal(data.pages.filter((p) => p.status === 200 && p.images !== undefined && !/\/cart\/?$/.test(path(p.finalUrl))));
  const noTitle = pages.filter((p) => !p.title);
  if (noTitle.length)
    out.push({ area: "seo", priority: "medium", issue: `${plural(noTitle.length, "page")} ${noTitle.length === 1 ? "has" : "have"} no title.`, fix: "Give every page a title: it's the headline people see in Google.", examples: noTitle.map((p) => path(p.finalUrl)) });
  const dupTitles = duplicates(pages, (p) => p.title);
  if (dupTitles.length)
    out.push({
      area: "seo",
      priority: dupTitles.flat().length >= 6 ? "medium" : "low",
      issue: `${plural(dupTitles.length, "title is", "titles are")} used on more than one page.`,
      fix: "Make each title unique, for example by adding the product name or the collection name, so Google knows which page to show.",
      examples: dupTitles.map((g) => `"${g[0]!.title}" on ${list(g.slice(0, 3).map((p) => path(p.finalUrl)))}${g.length > 3 ? ` and ${g.length - 3} more` : ""}`),
    });
  const noDesc = pages.filter((p) => !p.description);
  if (noDesc.length) {
    const homeMissing = noDesc.some((p) => path(p.finalUrl) === "/");
    out.push({
      area: "seo",
      priority: homeMissing || noDesc.length >= 10 ? "medium" : "low",
      issue: `${plural(noDesc.length, "page")} ${noDesc.length === 1 ? "has" : "have"} no meta description${homeMissing ? ", including your home page" : ""}.`,
      fix: "Write a one-or-two sentence description for each: it's the text under your link in Google, and a good one gets more clicks.",
      examples: noDesc.map((p) => path(p.finalUrl)),
    });
  }
  const dupDesc = duplicates(pages, (p) => p.description);
  if (dupDesc.length)
    out.push({
      area: "seo",
      priority: "low",
      issue: `${plural(dupDesc.length, "meta description is", "meta descriptions are")} repeated on more than one page.`,
      fix: "Give each page its own description that says what's on that page.",
      examples: dupDesc.map((g) => `${list(g.slice(0, 3).map((p) => path(p.finalUrl)))}${g.length > 3 ? ` and ${g.length - 3} more` : ""}`),
    });
  const noAlt = pages.filter((p) => (p.imagesMissingAlt ?? 0) > 0);
  const missingAlt = noAlt.reduce((n, p) => n + (p.imagesMissingAlt ?? 0), 0);
  if (missingAlt)
    out.push({
      area: "seo",
      priority: missingAlt >= 20 ? "medium" : "low",
      issue: `${plural(missingAlt, "image")} on ${plural(noAlt.length, "page")} ${missingAlt === 1 ? "has" : "have"} no alt text.`,
      fix: "Add a short description to each product and banner image (in the platform's image settings). It helps Google Images and shoppers using screen readers.",
      examples: noAlt.sort((a, b) => (b.imagesMissingAlt ?? 0) - (a.imagesMissingAlt ?? 0)).map((p) => `${path(p.finalUrl)} (${p.imagesMissingAlt})`),
    });
  if (data.sitemap.status !== 200)
    out.push({
      area: "seo",
      priority: "medium",
      issue: `Your sitemap (${path(data.sitemap.url)}) doesn't respond${data.sitemap.status ? ` (HTTP ${data.sitemap.status})` : ""}.`,
      fix: "Turn on or create a sitemap.xml and submit it in Google Search Console, so Google finds every product.",
    });
  if (data.robots.status !== 200)
    out.push({ area: "seo", priority: "low", issue: "Your site has no robots.txt file.", fix: "Add a robots.txt that points to your sitemap. Most platforms make one for you." });
  else if (data.robots.blocksAll)
    out.push({
      area: "seo",
      priority: "high",
      issue: "Your robots.txt tells search engines not to visit any page.",
      fix: "Remove the 'Disallow: /' line (it's often left over from building the site), or your shop drops out of Google.",
    });
  return out;
}

function dedupeByFinal(pages: PageCheck[]): PageCheck[] {
  const byFinal = new Map<string, PageCheck>();
  for (const p of pages) if (!byFinal.has(p.finalUrl.replace(/\/$/, ""))) byFinal.set(p.finalUrl.replace(/\/$/, ""), p);
  return [...byFinal.values()];
}

function duplicates(pages: PageCheck[], key: (p: PageCheck) => string | undefined): PageCheck[][] {
  const groups = new Map<string, PageCheck[]>();
  for (const p of pages) {
    const k = key(p)?.toLowerCase();
    if (k) groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
}

// ---------- security ----------

function security(data: SiteHealthData, now: Date): Finding[] {
  const out: Finding[] = [];
  const s = data.security;
  if (s.httpsRedirect === false)
    out.push({
      area: "security",
      priority: "high",
      issue: "Visiting your shop with plain http:// doesn't move shoppers to the secure https:// address.",
      fix: "Turn on 'force HTTPS' (or the redirect) in your hosting or platform settings, so browsers never show a 'not secure' warning.",
      examples: s.httpLandsOn ? [s.httpLandsOn] : undefined,
    });
  if (s.certError)
    out.push({ area: "security", priority: "high", issue: "We couldn't read your site's security certificate.", fix: "Ask your host to check the SSL certificate is installed and valid.", examples: [s.certError] });
  else if (s.certExpires) {
    const days = Math.floor((new Date(s.certExpires).getTime() - now.getTime()) / DAY);
    const date = new Date(s.certExpires).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    if (days < 0) out.push({ area: "security", priority: "high", issue: `Your security certificate ran out on ${date}.`, fix: "Renew it now: browsers are warning shoppers away." });
    else if (days < 14)
      out.push({ area: "security", priority: "high", issue: `Your security certificate runs out in ${plural(days, "day")} (${date}).`, fix: "Check auto-renewal is on with your host, or renew it this week." });
    else if (days < 30)
      out.push({ area: "security", priority: "medium", issue: `Your security certificate runs out on ${date}.`, fix: "Most hosts renew automatically; check yours does, so it doesn't lapse." });
  }
  return out;
}

/** When the certificate runs out, for the security status line. */
export function certLine(data: SiteHealthData): string | undefined {
  if (!data.security.certExpires) return undefined;
  return `Certificate valid until ${new Date(data.security.certExpires).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.`;
}

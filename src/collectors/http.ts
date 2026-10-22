const DEFAULT_USER_AGENT = "UndercutBot/0.1 (+https://github.com/wolfkeymedia/undercut)";

export interface FetchOptions {
  timeoutMs?: number;
  /** Minimum gap between two requests to the same host. */
  minIntervalMs?: number;
  respectRobots?: boolean;
}

export type Fetcher = (url: string) => Promise<FetchResult>;

export interface FetchResult {
  status: number;
  body: string;
  contentType: string;
}

export class BlockedByRobotsError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows ${url}`);
  }
}

/**
 * A fetcher that identifies itself, spaces out requests per host and honours
 * robots.txt. Collectors take a Fetcher so tests can pass a fake one.
 */
export function politeFetcher(options: FetchOptions = {}): Fetcher {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const minIntervalMs = options.minIntervalMs ?? 1_500;
  const respectRobots = options.respectRobots ?? true;
  const userAgent = process.env.UNDERCUT_USER_AGENT || DEFAULT_USER_AGENT;
  const lastRequestAt = new Map<string, number>();
  const robotsCache = new Map<string, RobotsRules>();

  async function raw(url: string): Promise<FetchResult> {
    const host = new URL(url).host;
    const wait = (lastRequestAt.get(host) ?? 0) + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt.set(host, Date.now());

    const res = await fetch(url, {
      headers: { "user-agent": userAgent, accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: await res.text(), contentType: res.headers.get("content-type") ?? "" };
  }

  return async (url) => {
    if (respectRobots) {
      const origin = new URL(url).origin;
      let rules = robotsCache.get(origin);
      if (!rules) {
        try {
          const res = await raw(`${origin}/robots.txt`);
          rules = res.status === 200 ? parseRobots(res.body) : { disallow: [], allow: [] };
        } catch {
          rules = { disallow: [], allow: [] };
        }
        robotsCache.set(origin, rules);
      }
      const u = new URL(url);
      if (!isAllowed(rules, u.pathname + u.search)) throw new BlockedByRobotsError(url);
    }
    return raw(url);
  };
}

export interface RobotsRules {
  disallow: string[];
  allow: string[];
}

/** Reads the rules that apply to every crawler ("User-agent: *"). */
export function parseRobots(text: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [] };
  let applies = false;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      // Consecutive user-agent lines share one group.
      applies = (lastWasAgent && applies) || value === "*";
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!applies) continue;
    if (field === "disallow" && value) rules.disallow.push(value);
    if (field === "allow" && value) rules.allow.push(value);
  }
  return rules;
}

/** Longest matching rule wins, and Allow wins a tie, as in Google's interpretation. */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  const longest = (patterns: string[]) =>
    Math.max(-1, ...patterns.filter((p) => robotsPatternMatches(p, path)).map((p) => p.length));
  return longest(rules.allow) >= longest(rules.disallow);
}

function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${regex}${anchored ? "$" : ""}`).test(path);
}

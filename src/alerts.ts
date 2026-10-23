import type { BriefItem } from "./brief/rank.js";
import { describeItem } from "./brief/write.js";

export type Poster = (url: string, body: unknown) => Promise<{ ok: boolean; status: number }>;

const defaultPoster: Poster = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { ok: res.ok, status: res.status };
};

/**
 * Sends the changes that can't wait for the weekly brief, as one message per
 * run. The body has a `text` field, which Slack incoming webhooks display
 * directly, plus the structured items for any other webhook consumer.
 */
export async function sendAlerts(
  items: BriefItem[],
  options: { webhookUrl?: string; minScore: number; merchantName: string; currency?: string },
  post: Poster = defaultPoster,
): Promise<number> {
  const urgent = items.filter((i) => i.score >= options.minScore);
  if (!options.webhookUrl || urgent.length === 0) return 0;

  const lines = urgent.map((i) => {
    let line = `• ${describeItem(i, options.currency)}`;
    if (i.suggestion) line += `\n   Suggested: ${i.suggestion}`;
    return line;
  });
  const body = {
    text: `*Undercut alert for ${options.merchantName}*: ${urgent.length} competitor ${urgent.length === 1 ? "change needs" : "changes need"} attention\n${lines.join("\n")}`,
    items: urgent.map((i) => ({
      kind: i.event.kind,
      competitor: i.competitor,
      product: i.event.title,
      url: i.event.url,
      before_cents: i.event.beforeCents,
      after_cents: i.event.afterCents,
      your_product: i.yourProduct?.title,
      suggestion: i.suggestion,
      score: Math.round(i.score),
    })),
  };
  const res = await post(options.webhookUrl, body);
  if (!res.ok) throw new Error(`Alert webhook returned HTTP ${res.status}`);
  return urgent.length;
}

import Anthropic from "@anthropic-ai/sdk";
import { formatCents, percentChange } from "../money.js";
import type { BriefItem } from "./rank.js";

export interface BriefContext {
  merchantName: string;
  weekOf: Date;
  currency?: string;
  /** Items beyond this are summarized as a count, so the brief stays short. */
  maxItems?: number;
}

const LABELS: Record<BriefItem["event"]["kind"], string> = {
  price_drop: "Price",
  price_increase: "Price",
  out_of_stock: "Stock",
  back_in_stock: "Stock",
  new_product: "Launch",
  removed_product: "Removed",
  promo_started: "Promo",
  promo_ended: "Promo",
};

/** One plain-English line per item. Used on its own without an API key, and as the fact sheet for Claude. */
export function describeItem(item: BriefItem, currency = "USD"): string {
  const money = (c: number) => formatCents(c, currency);
  const e = item.event;
  const who = item.competitor;
  switch (e.kind) {
    case "price_drop":
    case "price_increase": {
      const pct = percentChange(e.beforeCents!, e.afterCents!);
      let line = `${who} ${e.kind === "price_drop" ? "cut" : "raised"} ${e.title} from ${money(e.beforeCents!)} to ${money(e.afterCents!)} (${pct > 0 ? "+" : ""}${pct.toFixed(0)}%).`;
      if (item.yourProduct && item.gapCents !== undefined) {
        line +=
          item.gapCents < 0
            ? ` That is ${money(-item.gapCents)} below your ${item.yourProduct.title}.`
            : item.gapCents > 0
              ? ` You are ${money(item.gapCents)} cheaper.`
              : " That matches your price.";
      }
      return line;
    }
    case "out_of_stock":
      return `${who} is out of stock on ${e.title}.`;
    case "back_in_stock":
      return `${who} has ${e.title} back in stock.`;
    case "new_product":
      return `${who} added ${e.title}${e.afterCents !== undefined ? ` at ${money(e.afterCents)}` : ""}.`;
    case "removed_product":
      return `${who} removed ${e.title}.`;
    case "promo_started":
      return `${who} started a promotion: "${e.title}"${e.detail ? ` (${e.detail})` : ""}.`;
    case "promo_ended":
      return `${who} ended a promotion: "${e.title}".`;
  }
}

/** The brief as Markdown, written from a template. */
export function renderPlainBrief(items: BriefItem[], ctx: BriefContext): string {
  const max = ctx.maxItems ?? 8;
  const top = items.slice(0, max);
  const lines = [`# Weekly brief for ${ctx.merchantName}`, "", `Week of ${ctx.weekOf.toDateString()}`, ""];
  if (top.length === 0) {
    lines.push("Nothing changed at your competitors this week.");
    return lines.join("\n");
  }
  for (const item of top) {
    lines.push(`- **${LABELS[item.event.kind]}:** ${describeItem(item, ctx.currency)}`);
    if (item.suggestion) lines.push(`  - Suggested: ${item.suggestion}`);
  }
  if (items.length > max) lines.push("", `${items.length - max} smaller changes are in your dashboard.`);
  return lines.join("\n");
}

const SYSTEM_PROMPT = `You write a short weekly competitor brief for the owner of an online store.

You receive a ranked list of facts about what competitors changed this week, each with an optional suggested action that was computed from the store's own prices, costs and margins.

Write the brief in Markdown:
- A one-sentence summary of the week first.
- Then one bullet per fact, most important first, each starting with a bold label (Price, Promo, Stock, Launch or Removed).
- Under a bullet, give the suggested action when one is provided.
- End with nothing else: no sign-off and no offer of further help.

Use only the facts given. Keep every number, product name and competitor name exactly as written, and do not add actions, prices or percentages that are not in the facts. Write plainly for a busy shop owner who has two minutes.`;

/**
 * Writes the brief with Claude, from the ranked facts only. Falls back to the
 * plain template if the API is unavailable or declines, so a brief always goes out.
 */
export async function writeBrief(
  items: BriefItem[],
  ctx: BriefContext,
  client: Anthropic | null = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null,
): Promise<{ markdown: string; writer: "claude" | "template" }> {
  const plain = renderPlainBrief(items, ctx);
  if (!client || items.length === 0) return { markdown: plain, writer: "template" };

  const max = ctx.maxItems ?? 8;
  const facts = items.slice(0, max).map((item, i) => ({
    rank: i + 1,
    label: LABELS[item.event.kind],
    fact: describeItem(item, ctx.currency),
    suggested_action: item.suggestion ?? null,
  }));
  const request = {
    store: ctx.merchantName,
    week_of: ctx.weekOf.toDateString(),
    facts,
    smaller_changes_not_listed: Math.max(0, items.length - max),
  };

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(request, null, 2) }],
    });
    if (response.stop_reason !== "end_turn") return { markdown: plain, writer: "template" };
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return text ? { markdown: text, writer: "claude" } : { markdown: plain, writer: "template" };
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.warn(`Brief writer fell back to the template: API error ${err.status ?? ""} ${err.message}`);
      return { markdown: plain, writer: "template" };
    }
    throw err;
  }
}

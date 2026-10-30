import * as cheerio from "cheerio";
import { toCents } from "../money.js";
import type { Promotion } from "../types.js";

/** Elements where stores usually put sale messages. */
const PROMO_SELECTORS = [
  "[class*=announcement]",
  "[id*=announcement]",
  "[class*=promo]",
  "[class*=banner]",
  "[class*=marquee]",
  "[class*=ticker]",
  "[class*=notice]",
  "header",
].join(",");

const SALE_WORDS =
  /\b(black friday|cyber monday|boxing day|sitewide sale|site-wide sale|flash sale|clearance|end of season sale|summer sale|winter sale|spring sale|holiday sale|mega sale|bogo|buy one,? get one)\b/i;

/**
 * Finds promotions in a page's banners and header: percent or amount off,
 * discount codes, free-shipping thresholds and named sales.
 */
export function detectPromotions(html: string): Promotion[] {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg").remove();
  // Menus list categories like "10% Off Gift Sets" that are links, not running offers.
  $('button, nav, [role="navigation"], [class*="menu" i], [class*="navigation" i], [class*="megamenu" i]').remove();

  const texts = new Set<string>();
  $(PROMO_SELECTORS).each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text && text.length <= 600) texts.add(text);
  });
  // Also scan the start of the page, where hero banners live.
  texts.add($("body").text().replace(/\s+/g, " ").trim().slice(0, 1500));

  const found = new Map<string, Promotion>();
  const add = (p: Promotion) => {
    if (!found.has(p.key)) found.set(p.key, p);
  };

  for (const text of texts) {
    for (const sentence of splitSentences(text)) {
      const percent = sentence.match(/(?:up to |save |extra |take )?(\d{1,2})\s?%\s?off\b/i) ?? sentence.match(/\bsave (\d{1,2})\s?%/i);
      if (percent?.[1]) {
        const value = Number(percent[1]);
        add({ key: `percent_off:${value}`, kind: "percent_off", percentOff: value, text: sentence });
      }

      const amount = sentence.match(/([$£€]\s?\d+(?:[.,]\d{2})?)\s?off\b/i);
      if (amount?.[1]) {
        const cents = toCents(amount[1]);
        if (cents) add({ key: `amount_off:${cents}`, kind: "amount_off", amountOffCents: cents, text: sentence });
      }

      const shipping = sentence.match(/free (?:standard |express )?(?:shipping|delivery)(?: on (?:all )?orders)?(?: (?:over|above|of|from)\s?([$£€]\s?\d+(?:[.,]\d{2})?))?/i);
      if (shipping) {
        const threshold = shipping[1] ? toCents(shipping[1]) : undefined;
        add({
          key: `free_shipping:${threshold ?? "any"}`,
          kind: "free_shipping",
          thresholdCents: threshold,
          text: sentence,
        });
      }

      const code = sentence.match(/\b(?:use |with |enter )?(?:promo |discount |coupon )?code:?\s+["'“]?([A-Z0-9][A-Z0-9_-]{2,19})\b/);
      if (code?.[1] && /\d|[A-Z]{4,}/.test(code[1])) {
        add({ key: `discount_code:${code[1]}`, kind: "discount_code", code: code[1], text: sentence });
      }

      const sale = sentence.match(SALE_WORDS);
      if (sale?.[1]) {
        add({ key: `sale_banner:${sale[1].toLowerCase()}`, kind: "sale_banner", text: sentence });
      }
    }
  }
  return [...found.values()];
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!|•·])\s+|\s{2,}/)
    // Carousel controls often sit inside the banner and come out as a leading "Previous".
    .map((s) => s.trim().replace(/^(?:previous|next|prev)\b[\s:]*/i, ""))
    .filter((s) => s.length > 3)
    .map((s) => (s.length > 200 ? s.slice(0, 200) : s));
}

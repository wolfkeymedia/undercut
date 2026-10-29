import type { Market } from "../insights/market.js";
import { formatCents } from "../money.js";
import type { ChangeEvent } from "../types.js";
import { REPORT_CSS } from "./html.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MOVE_LABEL: Partial<Record<ChangeEvent["kind"], string>> = {
  price_drop: "Price cut",
  price_increase: "Price rise",
  out_of_stock: "Out of stock",
  back_in_stock: "Restocked",
  promo_started: "Promo",
  promo_ended: "Promo ended",
};

/**
 * The market view: what each competitor sells, at what prices, what is on offer
 * and what moved. Needs no merchant store, so it works from the first run.
 */
export function renderMarketReport(market: Market, options: { title?: string; since: Date; generatedAt?: Date }): string {
  const currencyOf = new Map(market.summaries.map((s) => [s.store.id, s.currency]));
  const nameOf = new Map(market.summaries.map((s) => [s.store.id, s.store.name]));
  const money = (storeId: string, c: number | undefined) => (c === undefined ? "—" : formatCents(c, currencyOf.get(storeId) ?? "EUR"));
  const generated = (options.generatedAt ?? new Date()).toLocaleString("en-IE", { dateStyle: "medium", timeStyle: "short" });
  const since = options.since.toLocaleDateString("en-IE", { day: "numeric", month: "short" });
  const title = options.title ?? "Competitor market";

  const totalProducts = market.summaries.reduce((s, x) => s + x.products, 0);
  const totalOffers = market.summaries.reduce((s, x) => s + x.onOffer, 0);
  const moves = [...market.counts.values()].reduce(
    (s, c) => s + (c.price_drop ?? 0) + (c.price_increase ?? 0) + (c.out_of_stock ?? 0) + (c.back_in_stock ?? 0),
    0,
  );
  const livePromos = market.summaries.reduce((s, x) => s + x.promotions.length, 0);

  const tiles = [
    tile("Products tracked", String(totalProducts), `across ${market.summaries.length} brands`),
    tile("On offer now", String(totalOffers), "products showing a was-price"),
    tile("Price and stock moves", String(moves), `since ${since}`),
    tile("Live promotions", String(livePromos), "sitewide banners and codes"),
  ].join("");

  const brandRows = market.summaries
    .map((s) => {
      const id = s.store.id;
      return `<tr>
        <td><a href="${esc(s.store.url)}">${esc(s.store.name)}</a><div class="sub">${s.inStock} of ${s.products} in stock</div></td>
        <td class="num">${s.products}</td>
        <td class="num">${money(id, s.minCents)}</td>
        <td class="num strong">${money(id, s.medianCents)}</td>
        <td class="num">${money(id, s.maxCents)}</td>
        <td class="num">${s.onOffer}${s.medianOfferPercent !== undefined ? `<div class="sub">typically ${s.medianOfferPercent}% off</div>` : ""}</td>
      </tr>`;
    })
    .join("");

  const storeIds = market.summaries.map((s) => s.store.id);
  const categoryRows = market.categories
    .map((row) => {
      const medians = storeIds.map((id) => row.byStore.get(id)?.medianCents).filter((x): x is number => x !== undefined);
      const low = Math.min(...medians);
      const cells = storeIds
        .map((id) => {
          const cell = row.byStore.get(id);
          if (!cell) return `<td class="num muted-t">—</td>`;
          const cheapest = medians.length > 1 && cell.medianCents === low;
          return `<td class="num${cheapest ? " good-t" : ""}">${money(id, cell.medianCents)}<div class="sub">${cell.count} ${cell.count === 1 ? "product" : "products"}</div></td>`;
        })
        .join("");
      return `<tr><td>${esc(row.category)}</td>${cells}</tr>`;
    })
    .join("");

  const offerRows = market.offers
    .map(
      (o) => `<tr>
        <td><a href="${esc(o.product.url)}">${esc(o.product.title)}</a><div class="sub">${esc(o.store.name)}</div></td>
        <td class="num strong">${money(o.store.id, o.product.priceCents)}</td>
        <td class="num"><s>${money(o.store.id, o.product.compareAtCents)}</s></td>
        <td class="num"><span class="pill bad">${o.percentOff}% off</span></td>
      </tr>`,
    )
    .join("");

  const promoList = market.summaries
    .flatMap((s) => s.promotions.map((p) => `<li><b>${esc(s.store.name)}:</b> ${esc(p.text)}</li>`))
    .join("");

  const moveList = market.moves
    .map((e) => {
      const name = nameOf.get(e.storeId) ?? e.storeId;
      const price =
        e.beforeCents !== undefined && e.afterCents !== undefined ? ` from ${money(e.storeId, e.beforeCents)} to ${money(e.storeId, e.afterCents)}` : "";
      const tone = e.kind === "price_drop" || e.kind === "promo_started" ? "bad" : e.kind === "out_of_stock" || e.kind === "price_increase" ? "good" : "muted";
      return `<li><span class="chip ${tone}">${MOVE_LABEL[e.kind] ?? e.kind}</span><div><p>${esc(name)}: ${esc(e.title)}${price}</p></div></li>`;
    })
    .join("");

  const catalogueNotes = market.summaries
    .map((s) => {
      const c = market.counts.get(s.store.id);
      const parts = [c?.new_product && `${c.new_product} new`, c?.removed_product && `${c.removed_product} removed`].filter(Boolean);
      return parts.length ? `${s.store.name}: ${parts.join(", ")}` : "";
    })
    .filter(Boolean)
    .join(" · ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Undercut</title>
<style>
${REPORT_CSS}
.muted-t { color: var(--muted); }
table.cats td:first-child { min-width: 150px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div><div class="brand">Undercut</div><h1>${esc(title)}</h1></div>
    <div class="meta">Watching ${market.summaries.map((s) => esc(s.store.name)).join(", ")} · Generated ${esc(generated)}</div>
  </header>

  <div class="tiles">${tiles}</div>

  <section>
    <h2>Brand by brand</h2>
    <div class="scroll"><table><thead><tr><th>Brand</th><th class="num">Products</th><th class="num">Cheapest</th><th class="num">Median price</th><th class="num">Dearest</th><th class="num">On offer</th></tr></thead><tbody>${brandRows}</tbody></table></div>
  </section>

  <section>
    <h2>Price by category</h2>
    ${
      categoryRows
        ? `<p class="sub" style="margin-bottom:10px">Median price of what each brand sells in the category. Green marks the cheaper brand.</p>
           <div class="scroll"><table class="cats"><thead><tr><th>Category</th>${market.summaries.map((s) => `<th class="num">${esc(s.store.name)}</th>`).join("")}</tr></thead><tbody>${categoryRows}</tbody></table></div>`
        : `<p class="empty">No categories in common yet.</p>`
    }
  </section>

  <div class="two">
    <section>
      <h2>Biggest offers right now</h2>
      ${offerRows ? `<div class="scroll"><table><thead><tr><th>Product</th><th class="num">Now</th><th class="num">Was</th><th class="num"></th></tr></thead><tbody>${offerRows}</tbody></table></div>` : `<p class="empty">Nothing is on offer.</p>`}
    </section>
    <section>
      <h2>Live promotions</h2>
      ${promoList ? `<ul class="plain">${promoList}</ul>` : `<p class="empty">No sitewide sale, discount code or free-shipping offer on any homepage right now.</p>`}
    </section>
  </div>

  <section>
    <h2>What moved since ${esc(since)}</h2>
    ${moveList ? `<ul class="changes">${moveList}</ul>` : `<p class="empty">No price, stock or promotion changes yet. These build up from one check to the next.</p>`}
    ${catalogueNotes ? `<p class="sub" style="margin-top:12px">Catalogue changes: ${esc(catalogueNotes)}.</p>` : ""}
  </section>

  <footer>
    Prices are read from each brand's public website. Was-prices are the ones the brand shows; on kits and sets they are often a standing saving against buying the items separately rather than a time-limited sale.
    Add your own store to see where you stand against each brand, with recommended price moves.
  </footer>
</div>
</body>
</html>
`;
}

function tile(label: string, value: string, note: string): string {
  return `<div class="tile"><span class="label">${esc(label)}</span><span class="value">${esc(value)}</span><span class="note">${esc(note)}</span></div>`;
}

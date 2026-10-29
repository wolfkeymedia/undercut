# Undercut

Competitor intelligence for online stores. Undercut watches competitor stores for price changes, stock-outs, promotions and new products, matches their products to yours, and tells a store manager three things every week:

1. **How much money is at stake.** Weekly sales exposed to cheaper rivals, and the margin you could add where you are already the cheapest.
2. **Which prices to change.** Recommendations that follow your own pricing rules and margin floor. When a cut would give away more margin than the sales it protects, Undercut says hold instead of starting a price war.
3. **What's coming.** Each competitor's promotion rhythm, so you see their next sale before it starts.

Urgent moves go straight to Slack. Everything else arrives as a weekly brief and a one-page report.

See it without setting anything up:

```sh
npm install && npm run demo   # writes demo-report.html and demo-brief.md for a sample coffee store
```

This repository holds the engine: collectors, change detection, product matching, storage and the brief writer, driven from a command line. The Shopify app and dashboard come next (see [Roadmap](#roadmap)).

## How it works

```
competitor sites ──► collectors ──► observations (Postgres) ──► change detector ──► events
your store ────────► collectors ──► your catalog + unit costs          │
                                         │                              ▼
                                         └──► product matcher ──► ranked brief ──► Claude (or template)
```

- **Collectors** (`src/collectors`) read a store's public Shopify product feed when it has one (one request per 250 products). Other stores are read page by page from their sitemap, using the schema.org product data most stores publish for Google Shopping. The homepage is scanned for promotions: percent or amount off, discount codes, free-shipping thresholds and named sales. Requests identify themselves, are spaced out per host and respect `robots.txt`. Stores that fill in prices with JavaScript are loaded in a headless browser (Playwright's Chromium) when it is installed. A store can be a regional part of a site, such as `https://brand.com/ie`, which keeps prices, currency and sitemaps to that region.
- **Change detection** (`src/detect`) compares each check with the previous one and records price drops and rises, stock-outs, restocks, new and removed products, and promotions starting or ending. The first check of a store is a baseline.
- **Matching** (`src/match`) suggests which competitor product corresponds to each of yours, using title similarity with sizes and quantities taken into account. Suggestions only count once you confirm them.
- **Insights** (`src/insights`) build the scorecard (where each product stands, a price index per competitor, sales at risk), turn your pricing rules into recommended prices, and find each competitor's promotion rhythm.
- **Briefs** (`src/brief`) collapse a week of events into net changes, rank them by money at stake, and attach a suggestion computed from your prices, costs and margin. Claude rewrites the ranked facts into a readable brief; without an API key, or if the call fails, a plain template is used so a brief always goes out.
- **Report** (`src/report`) renders the week as one self-contained HTML page that works offline and can be emailed.
- **Alerts** (`src/alerts.ts`) post the changes that can't wait to a Slack incoming webhook or any JSON endpoint after each run.

### How the money figures are worked out

- **Sales at risk**: for a product a rival sells cheaper, each 1% they undercut you is assumed to put `priceSensitivity`% (default 2%) of that product's weekly sales at risk, capped at `maxShareAtRisk` (default 60%). This is a planning estimate, not a measurement. Tune it to your category.
- **Margin you could add**: the extra margin from the recommended price rises, if unit sales hold.
- **Hold or cut**: a cut is recommended only when the margin at the new price beats the margin you would keep by doing nothing while the rival takes its share.

## Setup

Requires Node 22+ and Postgres 14+.

```sh
npm install
npx playwright install chromium   # optional: for stores that fill in prices with JavaScript
cp .env.example .env          # then fill in DATABASE_URL, and ANTHROPIC_API_KEY if you have one
export $(grep -v '^#' .env | xargs)
npm run db:migrate
```

## Using it

```sh
npm run cli -- add-store https://your-store.com --merchant --name "Your Store"
npm run cli -- add-store https://competitor-one.com
npm run cli -- add-store https://competitor-two.com --name "Competitor Two"

npm run cli -- run                     # check every store and suggest product matches
npm run cli -- matches                 # review suggested matches
npm run cli -- confirm 1 2 5           # confirm by number
npm run cli -- confirm-above 0.8       # or confirm everything above a confidence
npm run cli -- pair https://your-store.com/products/sculpt-stick https://rival.com/product/contour-wand
                                       # pair equivalent products by hand, for brands that sell their own lines
npm run cli -- import-products products.csv  # unit costs and weekly sales, so every figure is in money

npm run cli -- scorecard               # where each product stands, in the terminal
npm run cli -- prices --out prices.csv # recommended price changes
npm run cli -- report --out report.html
npm run cli -- market --out market.html  # competitors only: brands, prices by category, offers, promotions
npm run cli -- brief --days 7 --out brief.md
```

Until your own store is added, `report` writes the market report instead, so there is something to look at after the first run.

On Windows PowerShell, npm can swallow flags such as `--name` and `--out`. Pass them positionally (`npm run cli add-store https://brand.com "Brand Name"`, `npm run cli market market.html`) or run the CLI directly: `npx tsx src/cli.ts market --out market.html`.

Run `run` on a schedule (cron, or your host's scheduler) once or several times a day. Changes accumulate between runs and `brief` reports the last N days.

The products CSV needs one of `id`, `url` or `title` to identify each product, plus `cost`, `units_per_week` or both. Without these, Undercut still tracks competitors but can't put money figures on what it finds.

```csv
title,cost,units_per_week
Espresso Blend 1kg,20.00,40
Ethiopia Yirgacheffe 250g,9.50,25
```

### Settings

Copy `undercut.config.example.json` to `undercut.config.json` to change the defaults:

- `pricing.strategy`: `beat` (a little under the cheapest rival), `match`, or `premium` (a set percent above).
- `pricing.minMarginPercent`: never recommend a price below this margin. Default 25.
- `pricing.maxChangePercent`: the largest single price move. Default 15.
- `pricing.rounding`: `99` to end prices in .99, or `none`.
- `priceSensitivity` and `maxShareAtRisk`: the sales-at-risk estimate above.
- `alerts.webhookUrl` (or `UNDERCUT_ALERT_WEBHOOK`): where urgent changes are posted. `alerts.minScore` sets how urgent.

## Development

```sh
npm test             # unit and end-to-end tests with fake stores
npm run typecheck
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/undercut_test npm test   # also runs the Postgres tests
```

The Postgres tests drop and recreate the `public` schema of the database you point them at, so use a throwaway database.

## Roadmap

1. **Shopify app**: install flow, catalog, cost and sales import through the Admin API (no CSVs), one-click apply for recommended prices, the report as the app's home page, Shopify Billing.
2. **Scheduler and email**: a job queue that spreads checks over the day, and the weekly brief and report sent by email.
3. **Competitor discovery**: suggest competitors from the merchant's niche and keywords.
4. **Better matching**: image and embedding similarity, learning from confirmations.
5. **Headless browser fallback** for stores that render prices with JavaScript, with proxy rotation.
6. Version 2 modules: newsletter and ad tracking, reviews, pricing rules, MAP monitoring.

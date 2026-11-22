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

This repository holds the engine (collectors, change detection, product matching, storage and the brief writer), a command line, and a hosted web app for Vercel that runs it for any number of clients (see [Hosting on Vercel](#hosting-on-vercel)).

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
- `pricing.rounding`: `match` (default) to keep each product's own price ending, such as .95; `99` or `95` to force one; or `none`.
- `priceSensitivity` and `maxShareAtRisk`: the sales-at-risk estimate above.
- `alerts.webhookUrl` (or `UNDERCUT_ALERT_WEBHOOK`): where urgent changes are posted. `alerts.minScore` sets how urgent.

## Clients

One install serves many clients. A client is a business you watch competitors for: their own store, the competitors they care about, their product pairs, pricing rules and alert webhook. Adding a client needs no code change: use the web app's Add client form, or the CLI:

```sh
npm run cli -- add-client "SOSU Cosmetics"                     # prints the id, e.g. sosu-cosmetics
npm run cli -- add-store https://sosucosmetics.com --merchant --client sosu-cosmetics
npm run cli -- add-store https://www.charlottetilbury.com/ie --client sosu-cosmetics
npm run cli -- clients                                          # every client with its report link
```

Every CLI command takes `--client ID` (or `UNDERCUT_CLIENT`). Without it, commands work on the client `default`, which is where an install from before clients existed keeps its data after `migrate`. A competitor watched by several clients is collected once and shared; pairs, roles and settings stay per client.

## Hosting on Vercel

The web app (`src/web`) runs as one Vercel function (`api/index.js`, routed by `vercel.json`):

- **Admin** at `/`, behind `ADMIN_PASSWORD`: add clients and stores, review and confirm product pairs, pair by hand, set pricing rules and alerts, paste a costs CSV, connect Shopify, start a check.
- **Report links** at `/r/<token>`, one private link per client to share with them: the weekly report once their own store is added, the market view (`/r/<token>/market`) and recommended prices as CSV (`/r/<token>/prices.csv`). A link can be replaced from the client's page.
- **Daily checks** by Vercel cron: `/api/cron/collect` at 04:00 UTC starts one function per store. A large store without a Shopify feed is read in slices of about four minutes, each slice carrying on in a new function from where the last stopped, and unread products keep their last state so nothing reads as removed. `/api/cron/finish` at 06:00 UTC refreshes pairs, syncs Shopify figures and sends each client's urgent alerts.
- **Shopify (read-only)** at `/shopify/install` and `/shopify/callback`: the standard OAuth authorization-code grant with HMAC and state checks, asking only for `read_products`, `read_inventory` and `read_orders`. With the install, Undercut reads each product's unit cost and the last 28 days of unit sales, so reports put money figures on every move without a CSV. Tokens are stored encrypted (AES-256-GCM). `/shopify/webhooks` handles `app/uninstalled` and the privacy webhooks.

Pages that need JavaScript to show prices can't be rendered on Vercel (no headless browser); run the CLI with Playwright on your own machine for those stores, against the same database.

Environment variables (Project Settings, Environment Variables):

| Name | |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Use a pooled one (Neon's pooled URL, or Supabase on port 6543). `POSTGRES_URL` from a Vercel storage integration works too. Tables are created on first request. |
| `ADMIN_PASSWORD` | Password for the admin pages. |
| `UNDERCUT_SECRET` | 32+ random characters. Signs sign-in cookies and encrypts Shopify tokens; changing it signs everyone out and disconnects Shopify installs. |
| `CRON_SECRET` | Random string. Vercel sends it with cron calls; the app uses it for its own job calls. |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | Optional. Client ID and secret of a Shopify app from the Partner dashboard (or a custom app in a store's admin). Set the app's URL to `https://<your-domain>/shopify/install` and its allowed redirect URL to `https://<your-domain>/shopify/callback`. |
| `PAGESPEED_API_KEY` | Optional. A Google PageSpeed Insights API key (Google Cloud console, enable "PageSpeed Insights API", create an API key). Without it, the speed part of each client's Site health page shows as not connected. |
| `ANTHROPIC_API_KEY` | Optional, for Claude-written briefs. |
| `UNDERCUT_PUBLIC_URL` | Optional. The address to put in links, if not the one the request came in on. |

Run it locally the same way: `npm run build && npm run web`, with the same variables set.

## Development

```sh
npm test             # unit and end-to-end tests with fake stores
npm run typecheck
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/undercut_test npm test   # also runs the Postgres tests
```

The Postgres tests drop and recreate the `public` schema of the database you point them at, and create two more databases next to it (`undercut_web_test`, `undercut_tenancy_test`), so use a throwaway server.

## Roadmap

1. **Shopify app listing**: embedded admin page, one-click apply for recommended prices (needs write access), Shopify Billing. The read-only install already works.
2. **Email**: the weekly brief and report sent to each client by email.
3. **Competitor discovery**: suggest competitors from the merchant's niche and keywords.
4. **Better matching**: image and embedding similarity, learning from confirmations.
5. **Headless browser fallback** for stores that render prices with JavaScript, with proxy rotation.
6. Version 2 modules: newsletter and ad tracking, reviews, pricing rules, MAP monitoring.

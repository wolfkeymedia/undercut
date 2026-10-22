# Undercut

Competitor intelligence for online stores. Undercut watches competitor stores for price changes, stock-outs, promotions and new products, matches their products to yours, and writes a short weekly brief that says what changed and what to do about it.

This repository holds the engine: collectors, change detection, product matching, storage and the brief writer, driven from a command line. The Shopify app and dashboard come next (see [Roadmap](#roadmap)).

## How it works

```
competitor sites ──► collectors ──► observations (Postgres) ──► change detector ──► events
your store ────────► collectors ──► your catalog + unit costs          │
                                         │                              ▼
                                         └──► product matcher ──► ranked brief ──► Claude (or template)
```

- **Collectors** (`src/collectors`) read a store's public Shopify product feed when it has one (one request per 250 products). Other stores are read page by page from their sitemap, using the schema.org product data most stores publish for Google Shopping. The homepage is scanned for promotions: percent or amount off, discount codes, free-shipping thresholds and named sales. Requests identify themselves, are spaced out per host and respect `robots.txt`.
- **Change detection** (`src/detect`) compares each check with the previous one and records price drops and rises, stock-outs, restocks, new and removed products, and promotions starting or ending. The first check of a store is a baseline.
- **Matching** (`src/match`) suggests which competitor product corresponds to each of yours, using title similarity with sizes and quantities taken into account. Suggestions only count once you confirm them.
- **Briefs** (`src/brief`) collapse a week of events into net changes, rank them by likely impact on your sales, and attach a suggestion computed from your prices, costs and margin. Claude rewrites the ranked facts into a readable brief; without an API key, or if the call fails, a plain template is used so a brief always goes out.

## Setup

Requires Node 22+ and Postgres 14+.

```sh
npm install
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
npm run cli -- import-costs costs.csv  # optional: unit costs, so suggestions respect your margin

npm run cli -- brief --days 7 --out brief.md
```

Run `run` on a schedule (cron, or your host's scheduler) once or several times a day. Changes accumulate between runs and `brief` reports the last N days.

The costs CSV needs a header with a `cost` column and one of `id`, `url` or `title` to identify your product:

```csv
title,cost
Espresso Blend 1kg,20.00
Ethiopia Yirgacheffe 250g,9.50
```

## Development

```sh
npm test             # unit and end-to-end tests with fake stores
npm run typecheck
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/undercut_test npm test   # also runs the Postgres tests
```

The Postgres tests drop and recreate the `public` schema of the database you point them at, so use a throwaway database.

## Roadmap

1. **Shopify app**: install flow, catalog and cost import through the Admin API, Polaris dashboard, Shopify Billing for the Starter and Growth plans.
2. **Scheduler and alerts**: a job queue that spreads checks over the day, instant email and Slack alerts for big moves, weekly brief email.
3. **Competitor discovery**: suggest competitors from the merchant's niche and keywords.
4. **Better matching**: image and embedding similarity, learning from confirmations.
5. **Headless browser fallback** for stores that render prices with JavaScript, with proxy rotation.
6. Version 2 modules: newsletter and ad tracking, reviews, pricing rules, MAP monitoring.

-- Many clients on one install. Each client has its own store, its own
-- competitors, product pairs and settings. A store watched by several clients
-- is collected once and shared; who it is to each client lives in client_stores.
CREATE TABLE clients (
  id                    text PRIMARY KEY,
  name                  text NOT NULL,
  -- Secret part of the client's report link, so a client can view it without an account.
  report_token          text NOT NULL UNIQUE,
  -- Overrides of the default settings (pricing rules, alert webhook, estimates).
  settings              jsonb NOT NULL DEFAULT '{}',
  active                boolean NOT NULL DEFAULT true,
  shopify_shop          text,
  shopify_token_enc     text,
  shopify_scopes        text,
  shopify_installed_at  timestamptz,
  shopify_synced_at     timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE client_stores (
  client_id   text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  store_id    text NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('merchant', 'competitor')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, store_id)
);
CREATE UNIQUE INDEX client_stores_one_merchant ON client_stores (client_id) WHERE role = 'merchant';

-- An existing single-client install becomes the client "default".
INSERT INTO clients (id, name, report_token)
SELECT 'default', COALESCE((SELECT name FROM stores WHERE kind = 'merchant' ORDER BY created_at LIMIT 1), 'Default'),
       md5(random()::text || clock_timestamp()::text) || md5(random()::text)
WHERE EXISTS (SELECT 1 FROM stores);
INSERT INTO client_stores (client_id, store_id, role, created_at)
SELECT 'default', id, kind, created_at FROM stores;
ALTER TABLE stores DROP COLUMN kind;

-- Pairs belong to a client: two clients can pair the same competitor product differently.
ALTER TABLE product_matches ADD COLUMN client_id text NOT NULL DEFAULT 'default' REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE product_matches ALTER COLUMN client_id DROP DEFAULT;
ALTER TABLE product_matches DROP CONSTRAINT product_matches_pkey;
ALTER TABLE product_matches ADD PRIMARY KEY (client_id, merchant_external_id, competitor_store_id, competitor_external_id);

-- Large stores without a Shopify feed are read in slices; this is where the next run starts.
ALTER TABLE stores ADD COLUMN crawl_cursor integer NOT NULL DEFAULT 0;
ALTER TABLE stores ADD COLUMN last_checked_at timestamptz;
ALTER TABLE stores ADD COLUMN last_error text;

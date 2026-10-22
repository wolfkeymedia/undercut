-- Stores we watch: the merchant's own store and its competitors.
CREATE TABLE stores (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  url         text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('merchant', 'competitor')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per collection run of one store.
CREATE TABLE store_observations (
  id           bigserial PRIMARY KEY,
  store_id     text NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  observed_at  timestamptz NOT NULL,
  source       text NOT NULL,
  promotions   jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX store_observations_store_time ON store_observations (store_id, observed_at DESC);

-- Every product seen on every run. This is the price history.
CREATE TABLE product_observations (
  observation_id   bigint NOT NULL REFERENCES store_observations(id) ON DELETE CASCADE,
  store_id         text NOT NULL,
  external_id      text NOT NULL,
  observed_at      timestamptz NOT NULL,
  title            text NOT NULL,
  url              text NOT NULL,
  vendor           text,
  product_type     text,
  image_url        text,
  currency         text,
  price_cents      integer NOT NULL,
  compare_at_cents integer,
  available        boolean NOT NULL,
  PRIMARY KEY (observation_id, external_id)
);
CREATE INDEX product_observations_history ON product_observations (store_id, external_id, observed_at DESC);

-- Unit costs the merchant gives us, so briefs can reason about margin.
CREATE TABLE product_costs (
  store_id     text NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  external_id  text NOT NULL,
  cost_cents   integer NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, external_id)
);

CREATE TABLE change_events (
  id            bigserial PRIMARY KEY,
  store_id      text NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  occurred_at   timestamptz NOT NULL,
  external_id   text,
  promo_key     text,
  title         text NOT NULL,
  url           text,
  before_cents  integer,
  after_cents   integer,
  detail        text
);
CREATE INDEX change_events_time ON change_events (occurred_at DESC);

CREATE TABLE product_matches (
  merchant_external_id    text NOT NULL,
  competitor_store_id     text NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  competitor_external_id  text NOT NULL,
  confidence              real NOT NULL,
  status                  text NOT NULL CHECK (status IN ('suggested', 'confirmed', 'rejected')),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_external_id, competitor_store_id, competitor_external_id)
);

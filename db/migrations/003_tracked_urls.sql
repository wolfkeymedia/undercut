-- Product pages a merchant asked us to always check, e.g. ones paired by hand.
CREATE TABLE tracked_urls (
  store_id    text NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  url         text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, url)
);

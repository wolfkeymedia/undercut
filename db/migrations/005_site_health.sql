-- Site health checks of a client's own website. The result is kept as the raw
-- facts found; the findings shown on the report are worked out from them.
CREATE TABLE site_health_checks (
  id           bigserial PRIMARY KEY,
  client_id    text NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  site         text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  result       jsonb,
  error        text
);
CREATE INDEX site_health_checks_client ON site_health_checks (client_id, started_at DESC);

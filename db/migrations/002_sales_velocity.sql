-- Weekly unit sales let briefs put a money figure on each competitor move.
ALTER TABLE product_costs ADD COLUMN units_per_week real;
ALTER TABLE product_costs ALTER COLUMN cost_cents DROP NOT NULL;

-- schema.sql
-- Run this once against your database (Neon/Supabase/local Postgres) before seeding.

CREATE TABLE IF NOT EXISTS products (
  id          BIGSERIAL PRIMARY KEY,        -- monotonically increasing, unique, never reused
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  price       NUMERIC(10, 2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),  -- immutable once set; defines "newest first" order
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()   -- changes on edit, but is NEVER used for sorting/pagination
);

-- This composite index lets the filtered + sorted pagination query (category = X
-- ORDER BY created_at DESC, id DESC) be answered with a single index range scan:
-- no in-memory sort, no scanning-and-discarding rows. This is what keeps deep
-- pages just as fast as page 1, at 200k rows or 20 million rows.
CREATE INDEX IF NOT EXISTS idx_products_category_created_id
  ON products (category, created_at DESC, id DESC);

-- Same thing for the "no category filter" / "All categories" case.
CREATE INDEX IF NOT EXISTS idx_products_created_id
  ON products (created_at DESC, id DESC);

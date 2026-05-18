-- 0016 — Per-customer communication preferences. Strictly additive.
-- Stored as jsonb so we can grow the shape without further migrations.
-- See lib/client-prefs.ts for the shape contract.
BEGIN;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS comm_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;

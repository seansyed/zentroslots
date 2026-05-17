-- 0014 — Manager seat quotas. Strictly additive.
--
-- Adds quota_managers to the plans table for super-admin visibility +
-- editability. Runtime enforcement still uses lib/plans.ts constants
-- (consistent with the rest of the codebase) — this column is the
-- documented value an admin sees in the catalog.
BEGIN;

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS quota_managers integer NOT NULL DEFAULT 0;

-- Seed the existing free/pro/enterprise rows. Idempotent.
UPDATE plans SET quota_managers = 0  WHERE slug = 'free'       AND quota_managers IS NOT DISTINCT FROM 0;
UPDATE plans SET quota_managers = 2  WHERE slug = 'pro'        AND quota_managers IS NOT DISTINCT FROM 0;
UPDATE plans SET quota_managers = 10 WHERE slug = 'enterprise' AND quota_managers IS NOT DISTINCT FROM 0;

COMMIT;

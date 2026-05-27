-- Migration 0070: is_demo flag for tenants
--
-- Adds a per-tenant flag that marks a workspace as a non-production
-- demo/documentation environment. Used by:
--   • lib/demo-safe.ts — gates outbound side effects (email, push,
--     calendar sync) so demo activity never reaches real inboxes /
--     devices / Stripe accounts.
--   • Admin rollups — finance / tenant-intelligence / activity
--     center filter `is_demo = true` out so KPIs aren't skewed by
--     seeded fake data.
--   • scripts/seed-docs-demo.ts — marks every demo tenant it creates.
--
-- Belt-and-suspenders alongside the existing env-gated providers
-- (no STRIPE_SECRET_KEY / SMTP_HOST → those subsystems no-op anyway).
-- The flag exists so that even if a real env var lands later, demo
-- tenants stay quarantined from real-world outbound activity.
--
-- Additive + reversible: default false leaves every existing tenant
-- untouched.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

-- Partial index for the common "exclude demos" query path used by
-- every admin rollup. Small index, only covers demo rows.
CREATE INDEX IF NOT EXISTS tenants_is_demo_true_idx
  ON tenants (id)
  WHERE is_demo = true;

COMMENT ON COLUMN tenants.is_demo IS
  'When true, this tenant is a documentation/screenshot demo workspace. '
  'Outbound side effects (email, push, calendar sync, Stripe) are suppressed '
  'via lib/demo-safe.ts. Admin rollups exclude these rows. Seeded by '
  'scripts/seed-docs-demo.ts; reset via scripts/reset-docs-demo.ts.';

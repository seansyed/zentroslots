-- Onboarding Infrastructure Hardening — persistent progress, escape hatch,
-- partial completion model.
--
-- Adds three columns to `tenants`:
--   1. onboarding_started_at  — first time the wizard recorded any step
--   2. onboarding_skipped_at  — "finish later" escape hatch; admin opted
--                                out of forced wizard, but onboarding is
--                                NOT considered complete. Dashboard
--                                redirect gate checks both completed_at
--                                AND skipped_at.
--   3. onboarding_progress    — jsonb bag with per-step state, template
--                                application marker, and telemetry meta.
--
-- Backwards-compat notes:
--   • Existing tenants with `onboarding_completed_at` set are unaffected
--     — the dashboard's redirect gate still skips the wizard for them.
--   • Existing tenants with NULL `onboarding_completed_at` will see the
--     wizard with an empty progress object — behaving identically to the
--     pre-migration code path.
--   • All new columns are nullable / defaulted so deploy is safe with a
--     simple ALTER TABLE (no backfill required).
--
-- The jsonb shape is documented in lib/onboarding/types.ts; the column is
-- internal state, never joined, and intentionally untyped at the DB level
-- so we can evolve the wizard without further migrations.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS onboarding_started_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_skipped_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_progress    JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Tenants that were marked complete BEFORE this migration get a stamped
-- started_at equal to their completed_at, so analytics queries don't have
-- to special-case the pre-migration cohort.
UPDATE tenants
  SET onboarding_started_at = onboarding_completed_at
  WHERE onboarding_completed_at IS NOT NULL
    AND onboarding_started_at IS NULL;

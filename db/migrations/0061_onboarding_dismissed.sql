-- Migration 0061: onboarding_dismissed_at
--
-- Adds an explicit "user closed the dashboard onboarding checklist"
-- timestamp on tenants. This is DIFFERENT from the existing
-- `onboarding_skipped_at` (which is the wizard escape-hatch, used
-- by the redirect gate in app/dashboard/page.tsx to decide whether
-- to send a fresh admin into the wizard) and from
-- `onboarding_completed_at` (terminal completion).
--
-- Lifecycle:
--   • dismissed_at = NULL          checklist visible on dashboard
--   • dismissed_at = <timestamp>   user explicitly hid it; a small
--                                  "Resume setup" pill appears in
--                                  its place when the workspace is
--                                  not yet activated
--   • completed_at = <timestamp>   regardless of dismissed_at, the
--                                  checklist may still surface a
--                                  brief success card on next visit
--                                  unless ALSO dismissed
--
-- Why a new column vs reusing dismissed via a JSONB flag inside
-- onboarding_progress: the redirect gate at app/dashboard/page.tsx
-- and the success/dismiss UI are tight, hot-path code; a top-level
-- timestamp column is simpler to read + index + audit than a nested
-- JSONB read. Strictly additive.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS onboarding_dismissed_at timestamptz;

COMMENT ON COLUMN tenants.onboarding_dismissed_at IS
  'When the admin explicitly hid the dashboard onboarding checklist. Distinct from onboarding_skipped_at (wizard skip) and onboarding_completed_at (terminal completion). Phase Onboarding-UX (Migration 0061).';

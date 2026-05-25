-- Migration 0060: focus_rules columns for slot intelligence
--
-- Phase SMART-1 — adds optional per-tenant and per-staff scheduling
-- preferences that the slot intelligence engine consults when
-- ranking available times. STRICTLY ADDITIVE:
--   • Both columns are nullable.
--   • The intelligence engine ships with hardcoded sensible defaults;
--     these columns let an admin override on a per-tenant basis or
--     a staff member override per themselves.
--   • Pre-SMART-1 code paths NEVER read these columns.
--
-- Shape (application-enforced, not Postgres-enforced — JSONB is
-- flexible by design so future fields don't require migrations):
--
--   {
--     "lunchHours":         { "start": 12, "end": 13 },
--     "endOfDayDecayMin":   30,
--     "maxConsecutiveHours": 4,
--     "minBufferMinutes":   10,
--     "preferredHourStart": 9,
--     "preferredHourEnd":   17,
--     "quietHours":         [{ "start": 17, "end": 18 }],
--     "dailySoftCap":       8
--   }
--
-- Every field is OPTIONAL — the engine falls back to a default when
-- absent.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS focus_rules jsonb;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS focus_rules jsonb;

COMMENT ON COLUMN tenants.focus_rules IS
  'Optional tenant-level scheduling intelligence rules (lunch hours, end-of-day decay, soft caps, quiet hours). Engine uses defaults when null. Phase SMART-1.';
COMMENT ON COLUMN users.focus_rules IS
  'Optional per-staff override of tenant-level scheduling rules. Same shape as tenants.focus_rules. Phase SMART-1.';

-- 0075_availability_throttle.sql
-- Feature: "Show Fewer Open Slots" — per-staff PUBLIC availability throttling.
--
-- Adds three per-staff settings to `users`. They affect ONLY the public/
-- client-facing slot list (app/api/slots Mode B, non-internal callers); real
-- availability, working hours, buffers, conflicts, holidays, and timezone
-- logic are unchanged. Internal/admin slot views are never throttled.
--
-- Additive + idempotent. Apply via raw psql (drizzle journal is frozen).

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS show_fewer_open_slots boolean NOT NULL DEFAULT false;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS availability_display_mode varchar(20) NOT NULL DEFAULT 'normal';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS minimum_visible_slots_per_day integer NOT NULL DEFAULT 3;

COMMIT;

SELECT
  (SELECT count(*) FROM users WHERE show_fewer_open_slots) AS staff_throttling_enabled,
  (SELECT count(*) FROM users) AS total_users;

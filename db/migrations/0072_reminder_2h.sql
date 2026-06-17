-- 0072_reminder_2h.sql
-- Pre-launch notification completion: add the 2-hour customer reminder.
--
-- Adds the per-window claim flag `reminder_2h_sent_at` to bookings, mirroring
-- reminder_24h_sent_at / reminder_1h_sent_at. The reminder cron atomically
-- claims this flag (UPDATE ... WHERE reminder_2h_sent_at IS NULL AND
-- status='confirmed' RETURNING) before sending, so the 2h reminder fires
-- exactly once and reschedule clears it (set NULL) so it re-fires on the new
-- time. Purely additive + nullable — safe on a live DB.
--
-- Apply via raw psql (the drizzle journal is frozen at baseline; do NOT
-- db:push/db:migrate against prod).

BEGIN;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reminder_2h_sent_at timestamptz;

COMMIT;

SELECT 1 AS reminder_2h_applied;

-- 0071_comm_logs_dedupe_key.sql
-- Pre-launch hardening: deterministic dedup for cancellation + reschedule emails.
--
-- Adds a nullable `dedupe_key` discriminator to communication_logs and a
-- partial-unique index that INCLUDES it, so a 2nd LEGITIMATE reschedule
-- (different new-time → different key) is a distinct 'sent' row, while a
-- same-time retry (webhook/double-submit → same key) collides and is skipped.
--
-- The existing comm_logs_unique_success index is LEFT UNCHANGED: rows with
-- dedupe_key IS NULL (confirmation, reminders, cancellation — every current
-- caller) keep deduping on (tenant, booking, event, channel). Only reschedule
-- sets a dedupe_key, so confirmation/cancellation behavior is byte-identical.
--
-- Apply via raw psql (the drizzle journal is frozen at baseline; do NOT
-- db:push/db:migrate against prod). Idempotent + safe on a live DB.

BEGIN;

ALTER TABLE communication_logs
  ADD COLUMN IF NOT EXISTS dedupe_key varchar(120);

CREATE UNIQUE INDEX IF NOT EXISTS comm_logs_unique_success_keyed
  ON communication_logs (tenant_id, booking_id, event_type, channel, dedupe_key)
  WHERE status = 'sent' AND booking_id IS NOT NULL AND dedupe_key IS NOT NULL;

COMMIT;

SELECT 1 AS comm_logs_dedupe_key_applied;

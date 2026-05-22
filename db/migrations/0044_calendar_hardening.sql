-- Wave A — Calendar infrastructure security + correctness hardening.
--
-- Three concerns, one migration:
--
-- 1) Connection health foundation (Part 8 of the brief). Adds
--    consecutive-failure tracking + a last-reconnect-email timestamp
--    so the orchestrator can dedupe outbound staff notifications and
--    a future cron can do proactive health checks.
--
-- 2) Sync-log retry visibility (Part 7). Each calendar API call may
--    now retry on transient errors. Record the retry count on the
--    final log row so admins can see "succeeded after 2 retries"
--    vs "failed after 3 retries".
--
-- 3) Plaintext refresh-token cleanup (Part 1). The legacy
--    `users.google_refresh_token` column was being written in
--    plaintext on every OAuth callback alongside the encrypted
--    storage in `calendar_connections`. The cleanup is conservative:
--    we ONLY NULL out the legacy plaintext WHEN the user has an
--    active row in `calendar_connections` — meaning the encrypted
--    copy is in place and they won't lose connectivity. Users with
--    no new-table row are left alone (they'd need to reconnect
--    eventually, but won't be auto-disconnected by this migration).
--
-- All schema changes are additive + nullable; pre-migration tenants
-- behave byte-identically until the orchestrator starts populating
-- the new columns.

ALTER TABLE calendar_connections
  ADD COLUMN IF NOT EXISTS consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reconnect_email_at TIMESTAMPTZ;

ALTER TABLE calendar_sync_logs
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

-- Plaintext-token cleanup. Safe only for users with an active
-- encrypted row in calendar_connections.
UPDATE users u
   SET google_refresh_token = NULL,
       google_status        = NULL,
       google_last_error_at = NULL
 WHERE u.google_refresh_token IS NOT NULL
   AND EXISTS (
       SELECT 1
         FROM calendar_connections c
        WHERE c.user_id = u.id
          AND c.provider = 'google'
          AND c.status = 'active'
   );

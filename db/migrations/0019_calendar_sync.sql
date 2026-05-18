-- 0019 — External calendar sync.
--
-- Strictly additive. Two tables:
--   calendar_connections  — one row per (tenant, user, provider). Holds
--                           encrypted tokens, status, and the calendar id
--                           we're syncing into/from.
--   calendar_sync_logs    — every API call we make (create/update/delete/
--                           freebusy) gets one row. Failed rows carry the
--                           error class + message; status flips to
--                           'needs_reconnect' when we see auth errors.
--
-- Backward compat with users.googleRefreshToken / users.googleCalendarId:
-- the existing Google OAuth flow keeps writing those columns AND now also
-- writes a calendar_connections row. New code reads connections; old code
-- continues to read users columns until the latter are deprecated in a
-- future migration. Backfill: existing connected users get a row here
-- via the INSERT … SELECT below, so the dashboard shows their status
-- immediately after deploy.
--
-- Provider is a varchar (not enum) so MS Graph (Outlook/O365) can land
-- without a schema change — the lib's TypeScript union is the gatekeeper.
BEGIN;

CREATE TABLE IF NOT EXISTS calendar_connections (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'google' today; 'outlook' / 'office365' reserved for MS Graph.
  provider                 varchar(20) NOT NULL,
  -- 'active' | 'needs_reconnect' | 'disconnected'
  -- 'needs_reconnect' = token revoked / scopes changed / refresh failed.
  status                   varchar(20) NOT NULL DEFAULT 'active',
  -- Encrypted via lib/crypto.ts (AES-256-GCM). Stored as the v1: envelope.
  refresh_token_encrypted  text NOT NULL,
  -- Access tokens are cached only — googleapis lib refreshes on demand.
  access_token_encrypted   text,
  access_token_expires_at  timestamptz,
  -- Which calendar id we're targeting on the provider side.
  calendar_id              varchar(255) NOT NULL DEFAULT 'primary',
  -- Granted OAuth scopes for audit / drift detection.
  scopes                   jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Account-level metadata for the UI (email shown next to the tile).
  account_email            varchar(255),
  -- Operational state.
  last_synced_at           timestamptz,
  last_error               text,
  last_error_at            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
-- At most one ACTIVE connection per (user, provider). Reconnect updates
-- the row in place; disconnect flips status to 'disconnected' but keeps
-- the row for audit purposes — uniqueness predicate excludes it.
CREATE UNIQUE INDEX IF NOT EXISTS calendar_connections_active_unique
  ON calendar_connections(user_id, provider)
  WHERE status <> 'disconnected';
CREATE INDEX IF NOT EXISTS calendar_connections_tenant_idx
  ON calendar_connections(tenant_id);
CREATE INDEX IF NOT EXISTS calendar_connections_status_idx
  ON calendar_connections(status);

CREATE TABLE IF NOT EXISTS calendar_sync_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id   uuid REFERENCES calendar_connections(id) ON DELETE SET NULL,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Not an FK — booking may have been deleted; log survives.
  booking_id      uuid,
  provider        varchar(20) NOT NULL,
  -- 'create' | 'update' | 'delete' | 'freebusy' | 'connect' | 'disconnect'
  kind            varchar(20) NOT NULL,
  -- 'ok' | 'failed' | 'skipped'
  status          varchar(20) NOT NULL,
  -- For failures: 'auth' (revoked), 'rate_limit', 'not_found', 'transient', 'config', 'unknown'
  error_class     varchar(20),
  error_message   text,
  external_event_id varchar(255),
  latency_ms      integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_sync_logs_tenant_idx
  ON calendar_sync_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS calendar_sync_logs_connection_idx
  ON calendar_sync_logs(connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS calendar_sync_logs_booking_idx
  ON calendar_sync_logs(booking_id);

-- ─── Backfill from existing users.googleRefreshToken ────────────────────
-- One-shot: copy every currently-connected user into the new table so the
-- Settings → Calendar Connections page reflects reality on first load.
-- Refresh tokens were previously stored plaintext (legacy). We can't
-- encrypt them inside SQL — the orchestrator detects un-encrypted tokens
-- (no v1: prefix) and migrates them lazily on first use. Until then, the
-- row is marked 'needs_reconnect' so the user is prompted before any sync
-- write happens. This avoids a one-shot Node migration script.
INSERT INTO calendar_connections
  (tenant_id, user_id, provider, status, refresh_token_encrypted,
   calendar_id, account_email)
SELECT u.tenant_id, u.id, 'google',
       -- Force reconnect once: legacy tokens are plaintext, the new
       -- lib expects encrypted envelopes. Reconnect re-runs OAuth and
       -- the new lib writes encrypted from then on.
       'needs_reconnect',
       u.google_refresh_token,
       COALESCE(u.google_calendar_id, 'primary'),
       u.email
FROM users u
WHERE u.google_refresh_token IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM calendar_connections c
    WHERE c.user_id = u.id AND c.provider = 'google' AND c.status <> 'disconnected'
  );

-- Add bookings.external_event_id so we can target update/delete by the
-- provider's event id instead of guessing from local fields. Already
-- have bookings.google_event_id — keep it for backward compat; the new
-- column lets us record events from any provider on the same booking.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS external_event_id varchar(255),
  ADD COLUMN IF NOT EXISTS external_event_provider varchar(20);
CREATE INDEX IF NOT EXISTS bookings_external_event_idx
  ON bookings(external_event_id)
  WHERE external_event_id IS NOT NULL;

COMMIT;

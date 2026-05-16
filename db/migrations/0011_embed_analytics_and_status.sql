-- 0011_embed_analytics_and_status.sql
-- Embed page-view analytics + Google connection status flag.
-- Additive only. EXCLUDE constraint untouched.

BEGIN;

-- 1. Embed analytics: lightweight event log -----------------------------

CREATE TABLE IF NOT EXISTS embed_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id  uuid REFERENCES services(id) ON DELETE SET NULL,
  kind        varchar(40) NOT NULL,
  referer     text,
  ip          varchar(45),
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS embed_events_tenant_time_idx
  ON embed_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS embed_events_service_idx
  ON embed_events (service_id);
CREATE INDEX IF NOT EXISTS embed_events_kind_idx
  ON embed_events (kind);

-- 2. Google integration status flag --------------------------------------
-- Tracks the freshness of a staff user's Google connection so the dashboard
-- can show a "reconnect" banner when refresh-token operations fail.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_status         varchar(20),
  ADD COLUMN IF NOT EXISTS google_last_error_at  timestamptz;

-- 3. bookings_no_overlap EXCLUDE constraint: untouched.

COMMIT;

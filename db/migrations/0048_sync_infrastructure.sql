-- Wave E — sync infrastructure + scale hardening.
--
-- Three new tables (webhook_channels, freebusy_cache, sync_drift_events)
-- plus one column on calendar_connections for the multi-calendar
-- foundation (schema only — orchestrator doesn't read it yet).
--
-- All additive. Pre-Wave-E rows behave exactly as before.

-- ─── webhook_channels ─────────────────────────────────────────────────
-- One row per active push subscription on a provider. Google uses
-- channels.watch (returns a channel id + resource id; expires ~7 days).
-- Microsoft uses Graph subscriptions (returns a subscription id;
-- expires up to 70 days for outlook calendar). We unify both behind
-- this table so the renewal cron is provider-agnostic.
--
--   provider          : "google" | "microsoft"
--   external_channel_id: provider-side handle for cancelling/renewing
--   external_resource_id: only Google uses this (resourceId from the
--                        watch response); null for Microsoft
--   client_state      : random secret we generated and sent with the
--                        subscribe call. Incoming webhook payloads
--                        carry this back so we can prove the
--                        notification is authentic.
--   expires_at        : provider-supplied expiration. The renewal cron
--                        wakes up well before this and re-subscribes.
CREATE TABLE IF NOT EXISTS webhook_channels (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id         UUID NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider              VARCHAR(20) NOT NULL,
  external_channel_id   VARCHAR(255) NOT NULL,
  external_resource_id  VARCHAR(255),
  client_state          VARCHAR(64) NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  last_renewed_at       TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active webhook per connection at a time. If a renewal lands a
-- new channel id we DELETE the old row + INSERT the new one rather
-- than UPSERT in place (cleaner audit trail).
CREATE UNIQUE INDEX IF NOT EXISTS webhook_channels_connection_unique
  ON webhook_channels (connection_id);

CREATE INDEX IF NOT EXISTS webhook_channels_expires_idx
  ON webhook_channels (expires_at);

-- Receiver hot path: incoming webhooks carry external_channel_id and
-- we need to resolve to (tenant_id, user_id, connection_id) quickly.
CREATE INDEX IF NOT EXISTS webhook_channels_external_id_idx
  ON webhook_channels (external_channel_id);

-- ─── freebusy_cache ───────────────────────────────────────────────────
-- DB-backed cache of provider freebusy results, keyed by
-- (connection_id, window_start, window_end). The orchestrator's
-- getExternalBusyForUser reads this BEFORE hitting the provider API:
--   • Cache hit + not expired → return cached busy intervals
--   • Cache miss / expired    → fetch from provider, store result
-- Cache invalidation on webhook event: DELETE all rows for the
-- affected connection_id. Next read repopulates with fresh data.
--
-- TTL is per-row (expires_at column). We don't use a global TTL
-- because different windows have different freshness budgets — a
-- freebusy read for "next 60 minutes" can tolerate 30s staleness but
-- "next 4 weeks" can tolerate 5 minutes.
--
-- `busy_intervals` is a jsonb array of `{ "start": iso, "end": iso }`
-- objects. Reading code parses back to Date objects.
CREATE TABLE IF NOT EXISTS freebusy_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id   UUID NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  window_start    TIMESTAMPTZ NOT NULL,
  window_end      TIMESTAMPTZ NOT NULL,
  busy_intervals  JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup path: (connection_id, window_start, window_end). Exact match
-- only — different windows are separate cache entries.
CREATE INDEX IF NOT EXISTS freebusy_cache_lookup_idx
  ON freebusy_cache (connection_id, window_start, window_end);

-- Cleanup path: expired rows scanned and deleted by the cleanup cron.
CREATE INDEX IF NOT EXISTS freebusy_cache_expires_idx
  ON freebusy_cache (expires_at);

-- Invalidation path: webhook receiver DELETEs all rows for a
-- connection in one query.
CREATE INDEX IF NOT EXISTS freebusy_cache_connection_idx
  ON freebusy_cache (connection_id);

-- ─── sync_drift_events ────────────────────────────────────────────────
-- Records every detected drift between our booking state and the
-- provider's state. Wave E is detection-only: this table just
-- accumulates the evidence. Auto-repair is a future wave.
--
--   kind:
--     event_missing      → booking has externalEventId but provider
--                          returns 404
--     meeting_link_lost  → booking has meetLink but provider event no
--                          longer has one (rare — manual edit?)
--     time_mismatch      → provider event start/end differs from our
--                          booking row (someone moved the event in
--                          Google/Outlook directly)
--     external_event     → provider notification about an event we
--                          don't own (just logged; no action)
--   severity:
--     info   → external_event
--     warn   → meeting_link_lost, time_mismatch
--     error  → event_missing
CREATE TABLE IF NOT EXISTS sync_drift_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES calendar_connections(id) ON DELETE SET NULL,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  booking_id    UUID,
  provider      VARCHAR(20) NOT NULL,
  kind          VARCHAR(40) NOT NULL,
  severity      VARCHAR(10) NOT NULL DEFAULT 'warn',
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sync_drift_tenant_idx
  ON sync_drift_events (tenant_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS sync_drift_kind_idx
  ON sync_drift_events (kind);

-- ─── multi-calendar foundation ────────────────────────────────────────
-- One column. The orchestrator does NOT read this in Wave E — it's
-- pre-laid plumbing so a future wave can add a settings UI that lets
-- staff pick additional calendars (e.g. "vacations" + "team meetings")
-- to merge into their busy aggregation. Today every connection still
-- behaves as if it has exactly one calendar (the primary).
--
-- Shape: jsonb array of `{ "id": string, "summary": string }` objects.
-- Default empty array preserves existing behavior.
ALTER TABLE calendar_connections
  ADD COLUMN IF NOT EXISTS secondary_calendar_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Migration 0058: external_calendar_feeds + external_feed_events
--
-- Read-only inbound ICS feed import (Phase ICAL-3).
--
-- This is the ONLY honest, secure way to bring iCloud / shared Apple
-- calendars + published Outlook calendars into ZentroMeet's
-- availability engine:
--   • No CalDAV (Apple-ID-password storage is a security non-starter).
--   • No OAuth (iCloud has no calendar API; Outlook published links
--     don't require it).
--   • No write-back — these events block slots, they don't create
--     anything.
--
-- Two tables:
--   1. external_calendar_feeds  — the configured URL + metadata
--   2. external_feed_events     — the most-recent normalized event
--                                 set parsed from each feed
--
-- The event cache is REGENERATED on every sync (the feed itself is
-- always authoritative). It exists so the availability engine can
-- read busy windows from a single fast index without re-fetching
-- and re-parsing 50KB of iCal text on every slot request.
--
-- Per-feed event count is BOUNDED at the application layer (≤2000
-- per feed) to defend against unbounded recurrence explosion on a
-- pathological feed. The schema doesn't enforce that — it's a
-- business rule.

CREATE TABLE IF NOT EXISTS external_calendar_feeds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Human-readable label for the UI (e.g. "Apple iCloud personal",
  -- "Outlook published — team calendar"). Free-form; never used as
  -- an identifier.
  provider_label varchar(120) NOT NULL,
  -- Encrypted feed URL. We hold this at rest as ciphertext (AES-256-
  -- GCM via lib/crypto.ts) so a database dump never leaks the URL,
  -- which in some cases (Outlook published links) effectively grants
  -- read access to the underlying calendar without other auth.
  feed_url_encrypted text NOT NULL,
  -- SHA-256 hex of the NORMALIZED URL (trim + lowercase host).
  -- Used to:
  --   1. Deduplicate — a user can't add the same feed twice
  --      under the same workspace.
  --   2. Audit-log lookups WITHOUT decrypting the ciphertext
  --      (e.g. "show me activity for feed X").
  normalized_feed_hash varchar(64) NOT NULL,
  -- Coarse provider hint inferred from the URL host
  -- (apple_icloud | outlook | google | exchange | other). Stored so
  -- the UI can pick the right icon without re-parsing the URL on
  -- every render. Free-form short string; not a Postgres enum so
  -- adding hints later is a no-op.
  provider_kind varchar(20) NOT NULL DEFAULT 'other',
  -- Master enable switch. When false the sync worker skips the feed
  -- AND the availability engine treats its cached events as if
  -- they didn't exist. Soft-disable beats DELETE because admins want
  -- to "pause" without losing the URL config.
  is_enabled boolean NOT NULL DEFAULT true,
  -- Sync state — written by the sync orchestrator after each attempt.
  last_synced_at timestamptz,
  -- 'ok' | 'error' | 'pending' | 'rate_limited' | 'fetch_failed' |
  -- 'parse_failed' | 'too_large' | 'ssrf_blocked' — free-form short
  -- string, application enum.
  last_sync_status varchar(30),
  last_error text,
  -- Conditional-fetch hints from the upstream. When the server
  -- returns 304 Not Modified we can skip re-parsing entirely.
  etag varchar(255),
  last_modified varchar(64),
  -- Sync cadence bookkeeping — used by the cron worker to pick the
  -- batch of feeds to sync next. Ensures no feed gets starved.
  next_sync_after timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dedup at the workspace+user level. The dedup is on the HASH of the
-- normalized URL, not the URL itself (so we don't store a plaintext
-- key alongside the encrypted ciphertext).
CREATE UNIQUE INDEX IF NOT EXISTS external_calendar_feeds_user_dedupe
  ON external_calendar_feeds(tenant_id, user_id, normalized_feed_hash);

-- Hot lookup: "for this staff, give me every active feed". Used by
-- the availability engine.
CREATE INDEX IF NOT EXISTS external_calendar_feeds_active_idx
  ON external_calendar_feeds(tenant_id, user_id)
  WHERE is_enabled = true;

-- Sync worker batch picker — "give me the next 50 feeds that are
-- enabled and overdue". Partial index keeps it tight.
CREATE INDEX IF NOT EXISTS external_calendar_feeds_due_idx
  ON external_calendar_feeds(next_sync_after)
  WHERE is_enabled = true;

CREATE TABLE IF NOT EXISTS external_feed_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id uuid NOT NULL REFERENCES external_calendar_feeds(id) ON DELETE CASCADE,
  -- Denormalized for fast availability lookup. The availability
  -- engine queries by (tenant_id, user_id, start_at, end_at) and
  -- never joins back to external_calendar_feeds during a slot
  -- computation — that table is for management, not the hot path.
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The source UID from the upstream ICS. Used for incremental sync
  -- (delete + re-insert per-feed is fine for now, but the UID gives
  -- us the option to do diff-based updates later).
  source_uid varchar(255) NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  -- Apple/Outlook surface a SUMMARY; we keep it solely for the
  -- staff calendar render so they can see WHAT'S blocking a slot.
  -- Sanitized at parse time (strip CR/LF/control chars, truncate
  -- to 200 chars). Never surfaced on the customer-facing booking
  -- page — customers see the slot disappear, not why.
  summary varchar(200),
  -- iCal STATUS hint. Most calendars don't set this; when they do
  -- we honor CANCELLED by not blocking (the event is on the source
  -- calendar but the user explicitly cancelled it).
  status varchar(20),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Hot path: range scan by user + window. The availability engine
-- queries on (tenant_id, user_id, end_at >= window_start, start_at
-- <= window_end). The btree on (user_id, start_at) plus the implicit
-- range constraint gives us good pruning.
CREATE INDEX IF NOT EXISTS external_feed_events_user_window_idx
  ON external_feed_events(user_id, start_at, end_at);

CREATE INDEX IF NOT EXISTS external_feed_events_feed_idx
  ON external_feed_events(feed_id);

COMMENT ON TABLE external_calendar_feeds IS
  'User-configured external ICS feed URLs (Apple/iCloud, published Outlook, etc.). URLs encrypted at rest. Read-only inbound — never writes back to source. Phase ICAL-3 (Migration 0058).';

COMMENT ON TABLE external_feed_events IS
  'Materialized event cache from external_calendar_feeds. Regenerated on every sync. Read by the availability engine as a busy source. Never customer-facing. Phase ICAL-3 (Migration 0058).';

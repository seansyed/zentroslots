-- Migration 0059: external_calendar_feeds diagnostic columns
--
-- Phase ICAL-4 — adds observability columns to the existing Phase
-- ICAL-3 feed table. STRICTLY ADDITIVE: every new column is nullable
-- or has a safe default, so every code path that read or wrote feed
-- rows before this migration continues to work unchanged.
--
-- New columns:
--   • sync_duration_ms    — wall-clock duration of the last fetch +
--                           parse + write cycle. Powers admin
--                           dashboards + the per-feed UI chip.
--   • event_count         — number of events written on the last
--                           successful sync. Surfaced in the staff
--                           UI ("imported 47 events") and used by
--                           tenant-level analytics.
--   • consecutive_failures— counter for adaptive backoff +
--                           transitioning a feed into the "error"
--                           health state. Resets to 0 on any
--                           successful sync (ok or not_modified).
--   • notified_stale_at   — timestamp of the last "this feed has
--                           gone stale" in-app notification. Used
--                           to debounce — we re-notify at most once
--                           every 24 hours per feed.

ALTER TABLE external_calendar_feeds
  ADD COLUMN IF NOT EXISTS sync_duration_ms integer,
  ADD COLUMN IF NOT EXISTS event_count integer,
  ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notified_stale_at timestamptz;

-- Index for the admin observability endpoint's "show me the
-- problematic feeds" query — partial on failures > 0 to keep it
-- tight (most feeds are healthy).
CREATE INDEX IF NOT EXISTS external_calendar_feeds_failures_idx
  ON external_calendar_feeds(tenant_id, consecutive_failures)
  WHERE consecutive_failures > 0;

COMMENT ON COLUMN external_calendar_feeds.sync_duration_ms IS
  'Wall-clock duration of the last sync cycle (fetch + parse + write). Phase ICAL-4.';
COMMENT ON COLUMN external_calendar_feeds.event_count IS
  'Number of events written on the last successful sync. Surfaced in the staff UI. Phase ICAL-4.';
COMMENT ON COLUMN external_calendar_feeds.consecutive_failures IS
  'Counter for adaptive backoff. Resets to 0 on success. Phase ICAL-4.';
COMMENT ON COLUMN external_calendar_feeds.notified_stale_at IS
  'Timestamp of the last in-app stale-feed notification. Used to debounce. Phase ICAL-4.';

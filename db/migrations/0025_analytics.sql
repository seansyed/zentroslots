-- 0025 — Analytics daily snapshots.
--
-- Strictly additive. One row per (tenant, snapshot_date). The unique
-- index makes the aggregation worker safe to re-run for any given
-- date — UPSERT semantics with idempotent overwrite.
--
-- Snapshot values are DERIVED from production tables (bookings,
-- communication_logs, waitlists, staff_assignment_stats,
-- booking_occurrences) — never mocked. Tenants without rows here
-- still see the existing analytics page (graceful degradation per
-- rule #12).
BEGIN;

CREATE TABLE IF NOT EXISTS analytics_daily_snapshots (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The day this snapshot covers (UTC date — bookings.start_at falls
  -- inside [snapshot_date 00:00 UTC, +24h) for this snapshot).
  snapshot_date               date NOT NULL,
  -- Booking counts.
  total_bookings              integer NOT NULL DEFAULT 0,
  completed_bookings          integer NOT NULL DEFAULT 0,
  cancelled_bookings          integer NOT NULL DEFAULT 0,
  no_show_bookings            integer NOT NULL DEFAULT 0,
  recurring_bookings          integer NOT NULL DEFAULT 0,
  -- Waitlist counts.
  waitlist_joins              integer NOT NULL DEFAULT 0,
  waitlist_conversions        integer NOT NULL DEFAULT 0,
  -- Automation counts.
  review_requests_sent        integer NOT NULL DEFAULT 0,
  reviews_completed           integer NOT NULL DEFAULT 0,
  reminder_emails_sent        integer NOT NULL DEFAULT 0,
  reminder_emails_suppressed  integer NOT NULL DEFAULT 0,
  followups_sent              integer NOT NULL DEFAULT 0,
  -- Avg lead time (minutes between booking createdAt and startAt) for
  -- bookings starting on this snapshot_date. NULL when no bookings.
  average_booking_lead_hours  integer,
  -- jsonb side-channel for metrics that don't fit a single int — e.g.
  -- per-staff utilization, per-service popularity, busiest-hour
  -- distribution. Lets us add metrics without migrations.
  extras                      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analytics_daily_snapshots_tenant_idx
  ON analytics_daily_snapshots(tenant_id);
CREATE INDEX IF NOT EXISTS analytics_daily_snapshots_date_idx
  ON analytics_daily_snapshots(snapshot_date);
-- One row per (tenant, date). UPSERT key for the aggregation worker.
CREATE UNIQUE INDEX IF NOT EXISTS analytics_daily_snapshots_unique
  ON analytics_daily_snapshots(tenant_id, snapshot_date);

COMMIT;

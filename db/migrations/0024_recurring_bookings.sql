-- 0024 — Recurring bookings (series + rolling occurrence materialization).
--
-- Strictly additive. Tenants who never create a booking_series see
-- byte-identical behavior — the materialization worker is a no-op
-- with zero active series (rule #13).
--
-- booking_series         — the recurrence rule + customer + service.
--                          Status drives whether the worker materializes
--                          new occurrences ('active' → yes; 'paused' /
--                          'cancelled' / 'completed' → no).
-- booking_occurrences    — one row per future occurrence within the
--                          materialization window. Linked to a real
--                          booking row when successfully materialized.
--                          overrides jsonb carries per-occurrence
--                          deviations (different start time, staff, or
--                          'cancelled' / 'skipped' status).
--
-- The partial unique on (booking_series_id, occurrence_index) prevents
-- the worker from creating duplicate occurrence rows across re-runs.
BEGIN;

CREATE TABLE IF NOT EXISTS booking_series (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id              uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  staff_user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  location_id             uuid,
  customer_id             uuid,
  customer_email          varchar(255) NOT NULL,
  customer_name           varchar(120) NOT NULL,
  -- Minimal RRULE — see lib/recurrence/recurrenceRules.ts for the
  -- closed grammar. Example: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=10".
  recurrence_rule         text NOT NULL,
  -- Anchor for the series — local wall-clock time in `timezone`. The
  -- worker uses this + the rule to compute UTC occurrence start_ats.
  -- Stored as ISO local string ("YYYY-MM-DDTHH:MM:SS") so DST shifts
  -- preserve wall-clock time.
  start_local             varchar(19) NOT NULL,
  timezone                varchar(64) NOT NULL DEFAULT 'UTC',
  -- Optional series endpoints. NULL = open-ended (worker still uses
  -- the rule's UNTIL/COUNT to stop). If both UNTIL and end_date are
  -- set, whichever fires first wins.
  end_date                date,
  occurrence_count        integer,
  -- 'active' | 'paused' | 'cancelled' | 'completed'
  status                  varchar(20) NOT NULL DEFAULT 'active',
  -- High-water mark tracking — the worker resumes from here on each
  -- run instead of scanning from start_local.
  last_materialized_index integer NOT NULL DEFAULT -1,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_series_tenant_idx
  ON booking_series(tenant_id);
CREATE INDEX IF NOT EXISTS booking_series_status_idx
  ON booking_series(status);
CREATE INDEX IF NOT EXISTS booking_series_active_idx
  ON booking_series(tenant_id, status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS booking_occurrences (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_series_id       uuid NOT NULL REFERENCES booking_series(id) ON DELETE CASCADE,
  -- Set when the occurrence is materialized as a real booking. NULL
  -- means "scheduled but not yet inserted" or "skipped / cancelled".
  booking_id              uuid,
  -- 0-indexed position within the series (the n-th occurrence the
  -- rule produces). Used for idempotent re-materialization + for
  -- "Edit this + following" splits (future deferred).
  occurrence_index        integer NOT NULL,
  -- UTC start of the occurrence. Computed from start_local + the
  -- rule + timezone. The actual booking row holds duration, so the
  -- end is derived (occurrence_start + service.durationMinutes).
  occurrence_start_at     timestamptz NOT NULL,
  -- 'scheduled' | 'completed' | 'cancelled' | 'skipped' | 'failed'
  status                  varchar(20) NOT NULL DEFAULT 'scheduled',
  -- Per-occurrence deviations. Closed shape: { startAt?, staffUserId?,
  -- skip?: true, note? }. The materializer reads these to override
  -- rule defaults. Audit-friendly.
  overrides               jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_reason          text,
  attempts                integer NOT NULL DEFAULT 0,
  last_attempt_at         timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_occurrences_series_idx
  ON booking_occurrences(booking_series_id);
CREATE INDEX IF NOT EXISTS booking_occurrences_tenant_idx
  ON booking_occurrences(tenant_id);
CREATE INDEX IF NOT EXISTS booking_occurrences_status_idx
  ON booking_occurrences(status);
CREATE INDEX IF NOT EXISTS booking_occurrences_start_idx
  ON booking_occurrences(occurrence_start_at);
-- Idempotent materialization: a given (series, index) pair has at
-- most one row.
CREATE UNIQUE INDEX IF NOT EXISTS booking_occurrences_series_index_unique
  ON booking_occurrences(booking_series_id, occurrence_index);

-- Add a back-pointer on bookings so we can recognize a booking as
-- part of a series during cancel/reschedule flows (future: "cancel
-- this and following" semantics). Nullable column; absent value =
-- normal one-off booking.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS booking_series_id uuid
    REFERENCES booking_series(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS booking_occurrence_id uuid
    REFERENCES booking_occurrences(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS bookings_series_idx
  ON bookings(booking_series_id) WHERE booking_series_id IS NOT NULL;

COMMIT;

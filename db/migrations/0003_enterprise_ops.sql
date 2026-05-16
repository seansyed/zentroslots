-- 0003_enterprise_ops.sql
-- Enterprise scheduling ops: status enum expansion, availability overrides,
-- reminder tracking columns. Single transaction. EXCLUDE constraint untouched.

BEGIN;

-- 1. booking_status: add 'pending' and 'no_show'.
--    Postgres ADD VALUE requires existing transaction handling — IF NOT EXISTS
--    keeps re-runs safe.

ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'pending';
ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'no_show';

-- 2. availability_overrides
--    - unavailable=true with no times = full-day block
--    - 1+ rows with start/end times for same date = split-day schedule
--    - Tenant-scoped, user-scoped, indexed for fast date lookups

CREATE TABLE IF NOT EXISTS availability_overrides (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id      uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  date         date NOT NULL,
  unavailable  boolean NOT NULL DEFAULT false,
  start_time   time,
  end_time     time,
  reason       varchar(200),
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- If unavailable, times must be null. If available, both times required.
  CONSTRAINT availability_overrides_shape CHECK (
    (unavailable = true  AND start_time IS NULL AND end_time IS NULL) OR
    (unavailable = false AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
  )
);

CREATE INDEX IF NOT EXISTS availability_overrides_tenant_idx
  ON availability_overrides (tenant_id);
CREATE INDEX IF NOT EXISTS availability_overrides_user_date_idx
  ON availability_overrides (user_id, date);

-- 3. reminder tracking on bookings (per-row, simple, no separate table)

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reminder_24h_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_1h_sent_at  timestamptz;

CREATE INDEX IF NOT EXISTS bookings_reminder_24h_idx
  ON bookings (start_at)
  WHERE status = 'confirmed' AND reminder_24h_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS bookings_reminder_1h_idx
  ON bookings (start_at)
  WHERE status = 'confirmed' AND reminder_1h_sent_at IS NULL;

-- 4. bookings_no_overlap EXCLUDE constraint: intentionally untouched.

COMMIT;

-- 0030 — Paid-booking payment lifecycle. STRICTLY ADDITIVE.
--
-- Adds three enum values + four columns + ONE secondary unique index.
-- The existing bookings_no_overlap EXCLUDE constraint is UNTOUCHED —
-- it still applies only to status='confirmed'. The new states
-- (pending_payment, payment_failed, refunded) do NOT block confirmed
-- bookings via EXCLUDE. Soft holds for pending_payment are protected
-- by a SEPARATE partial unique index that only collides on exact
-- (staff_user_id, start_at) matches in the pending_payment state.
--
-- Free bookings continue to flow through the existing
-- status='confirmed' path with byte-identical behavior. Only services
-- with price_cents > 0 AND a tenant Stripe key go through the new
-- pending_payment → confirmed path.

-- NOTE: ALTER TYPE ADD VALUE must NOT be wrapped in the same
-- transaction as code that uses the new value. Postgres lets us
-- add values with IF NOT EXISTS in autocommit mode safely.

ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'pending_payment';
ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'payment_failed';
ALTER TYPE booking_status ADD VALUE IF NOT EXISTS 'refunded';

BEGIN;

-- Soft-hold metadata.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS payment_hold_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_session_id varchar(255),
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id varchar(255),
  -- The amount we charged at confirmation time (cents). Set on
  -- successful checkout, used for refund matching + analytics.
  ADD COLUMN IF NOT EXISTS amount_charged_cents integer;

-- Secondary unique index — additive, does NOT modify
-- bookings_no_overlap. Two concurrent pending_payment inserts for
-- the same (staff, slot) collide on 23505 here, before either
-- gets to be confirmed. Confirmation later still relies on the
-- EXCLUDE constraint to catch the rare case where a confirmed
-- booking sneaks in between the pending_payment and the
-- pending_payment→confirmed transition.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_pending_payment_unique
  ON bookings (staff_user_id, start_at)
  WHERE status = 'pending_payment';

-- Lookup index for cleanup cron — find expired holds fast.
CREATE INDEX IF NOT EXISTS bookings_payment_hold_expires_idx
  ON bookings (payment_hold_expires_at)
  WHERE status = 'pending_payment';

-- Lookup index for webhook handler — find a booking by its Stripe
-- session id. Partial because most bookings won't have one.
CREATE INDEX IF NOT EXISTS bookings_stripe_session_idx
  ON bookings (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bookings_stripe_pi_idx
  ON bookings (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

COMMIT;

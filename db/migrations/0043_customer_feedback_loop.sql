-- Customer Feedback Loop — Wave 4
--
-- Three additive features, one migration:
--
--   F30  Cancellation reason capture
--        bookings.cancellation_reason
--          → textarea on /cancel/[token] customer-facing page;
--            optional; null when unspecified
--
--   F31  Post-visit feedback (1-tap rating)
--        bookings.feedback_rating         smallint, 1..5, nullable
--        bookings.feedback_note           text, optional free-text
--        bookings.feedback_submitted_at   timestamptz, set on submit
--          → 1-tap star chips on the customer's bookings page for
--            completed bookings without feedback yet
--
--   F32  Notification read-state (unread indicator)
--        customers.notifications_last_seen_at
--          → updated when the customer visits /client/[slug]/notifications;
--            shell shows a dot on the Alerts nav when audit events newer
--            than this exist
--
-- All columns are nullable / defaulted; pre-migration tenants behave
-- byte-identically. The CHECK constraint on feedback_rating is added
-- via a DO block so the migration is re-runnable.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS cancellation_reason    TEXT,
  ADD COLUMN IF NOT EXISTS feedback_rating        SMALLINT,
  ADD COLUMN IF NOT EXISTS feedback_note          TEXT,
  ADD COLUMN IF NOT EXISTS feedback_submitted_at  TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'bookings_feedback_rating_range'
       AND conrelid = 'bookings'::regclass
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_feedback_rating_range
        CHECK (feedback_rating IS NULL OR (feedback_rating >= 1 AND feedback_rating <= 5));
  END IF;
END $$;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS notifications_last_seen_at TIMESTAMPTZ;

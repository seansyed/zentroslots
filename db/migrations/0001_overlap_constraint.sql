-- Run AFTER `drizzle-kit migrate` so the bookings table exists.
-- DB-level guarantee against double-booking the same staff member.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    staff_user_id WITH =,
    tstzrange(start_at, end_at) WITH &&
  )
  WHERE (status = 'confirmed');

-- 0076_phone_appointment_mode.sql
-- First-class PHONE appointment support — data layer (foundation).
--
-- ZentroMeet models delivery along the per-service `services.delivery_modes`
-- jsonb array (today: "in_person" / "virtual") plus `video_provider`. A "phone
-- appointment" had no first-class representation — it could only be faked as a
-- service name or as a no-video service, and nothing recorded the client's
-- phone number for the booking.
--
-- This migration adds the two per-BOOKING columns the feature needs:
--   • delivery_mode — the mode chosen at booking time
--                     ('in_person' | 'virtual' | 'phone' | 'custom').
--   • client_phone  — the phone number to call for a phone appointment.
--
-- The allowed `delivery_modes` value set is widened to include "phone" (and
-- "custom") in the APP layer only (lib/validation.ts). `delivery_modes` is
-- jsonb with no DB CHECK constraint, so NO database change is required there
-- and every existing services row keeps its array untouched.
--
-- PURELY ADDITIVE + IDEMPOTENT + BACKWARD-COMPATIBLE:
--   • Both columns are NULLABLE with no default. Every pre-existing booking
--     stays NULL = "unspecified" — read paths already tolerate this and render
--     exactly as they do today. No backfill, no rewrite, no NOT NULL.
--   • No constraint ties client_phone to delivery_mode; the "phone number
--     required for phone appointments" rule is enforced in the booking API /
--     flow (lib/validation.ts), keeping this migration non-breaking.
--   • Apply via raw psql in filename order (the drizzle journal is frozen):
--       for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done

BEGIN;

-- Per-booking delivery mode recorded at booking time. App-validated against
-- 'in_person' | 'virtual' | 'phone' | 'custom'. NULL on every pre-existing
-- booking and on any caller that does not send it → "unspecified" (display
-- falls back to the service's delivery_modes, i.e. current behavior).
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS delivery_mode varchar(20);

-- Client phone for the booking. The app requires this ONLY when
-- delivery_mode = 'phone' (enforced in the booking API/flow, not by a DB
-- constraint, so this migration stays non-breaking). NULL otherwise.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS client_phone varchar(40);

COMMIT;

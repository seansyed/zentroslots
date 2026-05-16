-- 0010_providers_and_webhooks.sql
-- Video providers per service + outbound notification webhook + white-label flag.
-- Additive only. EXCLUDE constraint untouched.

BEGIN;

-- 1. video provider on services -----------------------------------------

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS video_provider varchar(20) NOT NULL DEFAULT 'google_meet';

-- 2. Outbound webhook + plan flag on tenants -----------------------------

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS notification_webhook_url text,
  ADD COLUMN IF NOT EXISTS hide_powered_by         boolean NOT NULL DEFAULT false;

-- 3. bookings_no_overlap EXCLUDE constraint: untouched.

COMMIT;

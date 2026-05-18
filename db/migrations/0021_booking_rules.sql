-- 0021 — Booking rules (notice / advance / caps / cooldown / blackouts /
-- business hours).
--
-- Strictly additive. Tenants without any row in booking_rules see
-- byte-identical behavior — the existing services.minNoticeMinutes /
-- services.maxAdvanceDays checks in /api/bookings POST keep working
-- unchanged. New rule fields layer on top: when a booking_rules row
-- applies, ITS notice/advance values override the legacy services
-- fields. Everything else (caps, cooldown, etc.) is new — no legacy
-- equivalent.
--
-- Hierarchy: service > location > tenant default. Three partial
-- unique indexes keep one row per scope bucket. Validation hits the
-- MOST SPECIFIC matching row.
--
-- businessHours is jsonb so we don't need a separate
-- tenant_business_hours table for the requireBusinessHours flag.
-- Shape: {<weekday 0..6>: {start: "HH:MM", end: "HH:MM"}} or {}.
BEGIN;

CREATE TABLE IF NOT EXISTS booking_rules (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id                      uuid REFERENCES services(id) ON DELETE CASCADE,
  location_id                     uuid REFERENCES locations(id) ON DELETE SET NULL,
  enabled                         boolean NOT NULL DEFAULT true,
  -- Lead-time controls. Override services.min_notice_minutes /
  -- services.max_advance_days when present.
  min_notice_minutes              integer,
  max_advance_days                integer,
  -- Daily caps. NULL = unlimited.
  max_bookings_per_day            integer,
  max_bookings_per_customer_per_day integer,
  max_concurrent_bookings         integer,
  cooldown_minutes                integer,
  -- jsonb array of "YYYY-MM-DD" strings (per tenant tz).
  blackout_dates                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  require_business_hours          boolean NOT NULL DEFAULT false,
  -- {0..6: {start: "HH:MM", end: "HH:MM"}} keyed by day of week
  -- (Sunday=0). Empty object = no restriction.
  business_hours                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS booking_rules_tenant_idx
  ON booking_rules(tenant_id);
CREATE INDEX IF NOT EXISTS booking_rules_service_idx
  ON booking_rules(service_id);
CREATE INDEX IF NOT EXISTS booking_rules_location_idx
  ON booking_rules(location_id);

-- One rule per scope bucket per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS booking_rules_service_unique
  ON booking_rules(tenant_id, service_id)
  WHERE service_id IS NOT NULL AND location_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS booking_rules_location_unique
  ON booking_rules(tenant_id, location_id)
  WHERE service_id IS NULL AND location_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS booking_rules_default_unique
  ON booking_rules(tenant_id)
  WHERE service_id IS NULL AND location_id IS NULL;

COMMIT;

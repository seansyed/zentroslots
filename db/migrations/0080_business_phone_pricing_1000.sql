-- 0080_business_phone_pricing_1000.sql
-- ZentroMeet Business Phone — single launch plan repricing ($29/mo, 1,000 min).
--
-- Launch decision: consolidate to ONE Business Phone plan — $29/month with
-- 1,000 US & Canada minutes included (was the $19 / 200-minute assumption).
-- This migration moves the COLUMN DEFAULTS for tenant_phone_settings from 200
-- to 1000 so newly provisioned tenants get the new package.
--
-- DEFAULTS ONLY — DELIBERATELY NON-DESTRUCTIVE:
--   • Changes ONLY the column DEFAULT used for future INSERTs that omit the
--     value. It does NOT run any UPDATE, so EXISTING rows keep their current
--     cap (e.g. the docs-demo pilot stays at whatever it was provisioned with).
--   • Existing assigned tenants are intentionally NOT modified here. If/when an
--     existing tenant should move to 1,000 minutes that is a separate, explicit,
--     per-tenant data change (super-admin re-assign), not a silent global bump.
--   • The app already passes explicit included_minutes / monthly_minute_cap on
--     every assignment (lib/business-phone-admin.ts now defaults to 1000), so
--     this DEFAULT is the belt-and-suspenders fallback that keeps the live DB
--     consistent with db/schema.ts.
--
-- Idempotent: SET DEFAULT is naturally idempotent. No data is read or written.

ALTER TABLE tenant_phone_settings
  ALTER COLUMN included_minutes SET DEFAULT 1000;

ALTER TABLE tenant_phone_settings
  ALTER COLUMN monthly_minute_cap SET DEFAULT 1000;

-- 0018 — Per-tenant feature toggles.
--
-- Strictly additive. One row per tenant; absence means "all defaults"
-- (everything on). Engine + APIs + UI consult lib/features.ts which
-- reads this table with an in-process TTL cache.
--
-- Schema-as-jsonb (rather than a column per toggle) keeps future
-- additions migration-free at the storage layer. The TypeScript loader
-- is the authoritative source of which keys are valid + their defaults
-- — unknown keys are ignored, missing keys fall back to default-on.
--
-- Only the five toggles whose runtime backend exists are honored today:
--   reminders, rescheduling, cancellations, intakeForms, googleMeet
-- Storing other keys here is a no-op until those features ship.
BEGIN;

CREATE TABLE IF NOT EXISTS tenant_feature_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flags       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_feature_settings_tenant_unique
  ON tenant_feature_settings(tenant_id);

COMMIT;

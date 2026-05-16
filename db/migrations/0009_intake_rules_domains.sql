-- 0009_intake_rules_domains.sql
-- Intake forms + booking rules + custom domains foundation.
-- Additive only. EXCLUDE constraint untouched.

BEGIN;

-- 1. intake_forms --------------------------------------------------------

CREATE TABLE IF NOT EXISTS intake_forms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        varchar(120) NOT NULL,
  fields      jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS intake_forms_tenant_idx ON intake_forms (tenant_id);

-- 2. service ↔ intake form + booking rules --------------------------------

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS intake_form_id      uuid REFERENCES intake_forms(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS min_notice_minutes  integer,
  ADD COLUMN IF NOT EXISTS max_advance_days    integer;

-- 3. intake responses on bookings ----------------------------------------

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS intake_responses jsonb,
  ADD COLUMN IF NOT EXISTS assignment_mode  varchar(20) NOT NULL DEFAULT 'direct';

-- 4. tenant_domains foundation -------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_domains (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  host                varchar(253) NOT NULL,
  verification_token  varchar(64) NOT NULL,
  verified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_domains_host_unique ON tenant_domains (lower(host));
CREATE INDEX        IF NOT EXISTS tenant_domains_tenant_idx ON tenant_domains (tenant_id);

-- 5. bookings_no_overlap EXCLUDE constraint: untouched.

COMMIT;

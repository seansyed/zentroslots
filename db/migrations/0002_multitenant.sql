-- 0002_multitenant.sql
-- Convert single-workspace schema to multi-tenant.
-- Single transaction: either all of this lands or none of it does.
-- Backfills all existing rows to a "Default Workspace" tenant.
-- Preserves the bookings_no_overlap EXCLUDE constraint untouched.

BEGIN;

-- 1. tenants table -------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(120) NOT NULL,
  slug        varchar(80)  NOT NULL,
  plan        varchar(40)  NOT NULL DEFAULT 'free',
  active      boolean      NOT NULL DEFAULT true,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_unique ON tenants (slug);
CREATE INDEX        IF NOT EXISTS tenants_active_idx  ON tenants (active);

-- 2. default tenant (anchor for backfill) --------------------------------

INSERT INTO tenants (name, slug, plan, active)
VALUES ('Default Workspace', 'default', 'free', true)
ON CONFLICT (slug) DO NOTHING;

-- 3. add tenant_id to all five tables (nullable initially) ---------------

ALTER TABLE users         ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE services      ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE service_staff ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE availability  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE bookings      ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;

-- 4. backfill -------------------------------------------------------------

UPDATE users         SET tenant_id = (SELECT id FROM tenants WHERE slug = 'default') WHERE tenant_id IS NULL;
UPDATE services      SET tenant_id = (SELECT id FROM tenants WHERE slug = 'default') WHERE tenant_id IS NULL;
UPDATE service_staff SET tenant_id = (SELECT id FROM tenants WHERE slug = 'default') WHERE tenant_id IS NULL;
UPDATE availability  SET tenant_id = (SELECT id FROM tenants WHERE slug = 'default') WHERE tenant_id IS NULL;
UPDATE bookings      SET tenant_id = (SELECT id FROM tenants WHERE slug = 'default') WHERE tenant_id IS NULL;

-- 5. enforce NOT NULL ----------------------------------------------------

ALTER TABLE users         ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE services      ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE service_staff ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE availability  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE bookings      ALTER COLUMN tenant_id SET NOT NULL;

-- 6. unique email is now (tenant_id, email) ------------------------------

DROP INDEX IF EXISTS users_email_unique;
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_email_unique ON users (tenant_id, email);

-- 7. tenant indexes for hot read paths -----------------------------------

CREATE INDEX IF NOT EXISTS users_tenant_idx         ON users         (tenant_id);
CREATE INDEX IF NOT EXISTS services_tenant_idx      ON services      (tenant_id);
CREATE INDEX IF NOT EXISTS service_staff_tenant_idx ON service_staff (tenant_id);
CREATE INDEX IF NOT EXISTS availability_tenant_idx  ON availability  (tenant_id);
CREATE INDEX IF NOT EXISTS bookings_tenant_idx      ON bookings      (tenant_id);

-- 8. bookings_no_overlap EXCLUDE constraint: intentionally untouched.
--    staff_user_id is globally unique and each staff belongs to exactly
--    one tenant, so the existing constraint remains tenant-correct.

COMMIT;

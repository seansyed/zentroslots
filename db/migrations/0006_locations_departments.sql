-- 0006_locations_departments.sql
-- Locations + Departments foundation. Additive only.
-- All new columns on existing tables are NULLABLE so backfill is automatic.
-- EXCLUDE constraint untouched.

BEGIN;

-- 1. locations -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        varchar(120) NOT NULL,
  address     text,
  timezone    varchar(64),
  phone       varchar(40),
  email       varchar(255),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS locations_tenant_idx ON locations (tenant_id);
CREATE INDEX IF NOT EXISTS locations_active_idx ON locations (is_active);

-- 2. departments ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        varchar(120) NOT NULL,
  color       varchar(20),
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS departments_tenant_idx ON departments (tenant_id);

-- 3. service color + nullable assignment columns -------------------------

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS color varchar(20);

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS location_id   uuid REFERENCES locations(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES departments(id) ON DELETE SET NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS primary_location_id uuid REFERENCES locations(id)   ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS department_id       uuid REFERENCES departments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bookings_location_idx   ON bookings (location_id)   WHERE location_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS bookings_department_idx ON bookings (department_id) WHERE department_id IS NOT NULL;

-- 4. bookings_no_overlap EXCLUDE constraint: untouched.

COMMIT;

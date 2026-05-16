-- 0007_customers_and_profiles.sql
-- Customers entity + staff profile fields. Additive only.
-- EXCLUDE constraint untouched.

BEGIN;

-- 1. customers ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        varchar(120) NOT NULL,
  email       varchar(255) NOT NULL,
  phone       varchar(40),
  notes       text,
  tags        jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      varchar(40) NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_email_unique
  ON customers (tenant_id, lower(email));
CREATE INDEX IF NOT EXISTS customers_tenant_idx ON customers (tenant_id);

-- 2. bookings.customer_id ------------------------------------------------

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS bookings_customer_idx ON bookings (customer_id) WHERE customer_id IS NOT NULL;

-- 3. staff profile fields on users --------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url  text,
  ADD COLUMN IF NOT EXISTS bio         text,
  ADD COLUMN IF NOT EXISTS specialties text;

-- 4. bookings_no_overlap EXCLUDE constraint: untouched.

COMMIT;

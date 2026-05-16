-- 0004_saas_commercial.sql
-- Billing, branding, public profile slugs, onboarding tracking.
-- Additive only. EXCLUDE constraint untouched.

BEGIN;

-- 1. Billing on tenants ---------------------------------------------------

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_customer_id      varchar(120),
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  varchar(120),
  ADD COLUMN IF NOT EXISTS subscription_status     varchar(40),
  ADD COLUMN IF NOT EXISTS trial_end               timestamptz,
  ADD COLUMN IF NOT EXISTS current_plan            varchar(40) NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS billing_email           varchar(255);

CREATE UNIQUE INDEX IF NOT EXISTS tenants_stripe_customer_unique
  ON tenants (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_stripe_subscription_unique
  ON tenants (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

-- 2. Branding on tenants --------------------------------------------------

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS logo_url           text,
  ADD COLUMN IF NOT EXISTS primary_color      varchar(20) NOT NULL DEFAULT '#2563eb',
  ADD COLUMN IF NOT EXISTS tagline            varchar(200),
  ADD COLUMN IF NOT EXISTS description        text,
  ADD COLUMN IF NOT EXISTS booking_headline   varchar(200);

-- 3. Onboarding marker ----------------------------------------------------

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

-- 4. Per-tenant service slugs (for /u/[slug]/[serviceSlug] URLs) ---------

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS slug varchar(80);

-- Backfill: derive a deterministic slug from name for any null rows.
UPDATE services
   SET slug = regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')
 WHERE slug IS NULL;

UPDATE services
   SET slug = trim(both '-' from slug);

-- If anything is still empty or collides, suffix with first 8 of id.
UPDATE services
   SET slug = slug || '-' || substring(id::text, 1, 8)
 WHERE slug IS NULL OR slug = '' OR id IN (
   SELECT id FROM (
     SELECT id, row_number() OVER (PARTITION BY tenant_id, slug ORDER BY created_at) AS rn
     FROM services
   ) s WHERE rn > 1
 );

ALTER TABLE services ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS services_tenant_slug_unique
  ON services (tenant_id, slug);

-- 5. bookings_no_overlap EXCLUDE constraint: intentionally untouched.

COMMIT;

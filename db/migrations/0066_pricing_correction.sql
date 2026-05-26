-- Pricing correction — match the actual marketing-site pricing.
--
-- The prior migration (0065) misread the strategy. The real public
-- pricing surfaces FIVE tiers:
--
--   Free        $0           — 1 seat, 3 services, basic reminders
--   Solo        $10  / $110  — 1 seat, unlimited services + branding + analytics
--   Pro         $30  / $330  — 3 seats + 1 manager, full analytics + reports
--   Team        $100 / $1100 — 10 seats + 1 manager, advanced reporting + priority support
--   Enterprise  $250 / $2750 — unlimited everything, SSO, SLA, dedicated onboarding
--
-- This migration is corrective + idempotent (ON CONFLICT DO UPDATE).
-- Plan slugs are NEVER renamed. Tenants pointing at any of these
-- slugs keep working. The previously-added 'business' slug is
-- DEACTIVATED (active=false) rather than deleted — preserving any
-- tenant rows that may still point at it (seeded simulation
-- tenants from the last wave). Reset simulation will remove them.

-- ─── Free ──────────────────────────────────────────────────────────
INSERT INTO plans (
  slug, name, description,
  price_monthly_cents, price_yearly_cents,
  quota_staff, quota_managers, quota_bookings_per_month, quota_services,
  features, active, sort_order
) VALUES (
  'free', 'Free', 'Everything an individual needs to start taking bookings online.',
  0, 0,
  1, 0, -1, 3,
  '["1 staff seat","Up to 3 active services","Unlimited bookings","Public booking page","Basic reminders","No credit card required"]'::jsonb,
  true, 0
) ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_monthly_cents = EXCLUDED.price_monthly_cents,
  price_yearly_cents = EXCLUDED.price_yearly_cents,
  quota_staff = EXCLUDED.quota_staff,
  quota_managers = EXCLUDED.quota_managers,
  quota_bookings_per_month = EXCLUDED.quota_bookings_per_month,
  quota_services = EXCLUDED.quota_services,
  features = EXCLUDED.features,
  active = EXCLUDED.active,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

-- ─── Solo $10/mo ──────────────────────────────────────────────────
INSERT INTO plans (
  slug, name, description,
  price_monthly_cents, price_yearly_cents,
  quota_staff, quota_managers, quota_bookings_per_month, quota_services,
  features, active, sort_order
) VALUES (
  'solo', 'Solo', 'For solo professionals who want unlimited scheduling and their own branding.',
  1000, 11000,
  1, 0, -1, -1,
  '["1 staff seat","Unlimited services","Unlimited bookings","Branding removal","Analytics access","Email templates","Basic reporting"]'::jsonb,
  true, 10
) ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_monthly_cents = EXCLUDED.price_monthly_cents,
  price_yearly_cents = EXCLUDED.price_yearly_cents,
  quota_staff = EXCLUDED.quota_staff,
  quota_managers = EXCLUDED.quota_managers,
  quota_bookings_per_month = EXCLUDED.quota_bookings_per_month,
  quota_services = EXCLUDED.quota_services,
  features = EXCLUDED.features,
  active = EXCLUDED.active,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

-- ─── Pro $30/mo ───────────────────────────────────────────────────
INSERT INTO plans (
  slug, name, description,
  price_monthly_cents, price_yearly_cents,
  quota_staff, quota_managers, quota_bookings_per_month, quota_services,
  features, active, sort_order
) VALUES (
  'pro', 'Pro', 'For small teams that need manager oversight and full analytics.',
  3000, 33000,
  3, 1, -1, -1,
  '["3 staff seats","1 manager seat","Full analytics","Executive dashboard","Reports center","Communications command center","Reminder automations","Advanced branding"]'::jsonb,
  true, 20
) ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_monthly_cents = EXCLUDED.price_monthly_cents,
  price_yearly_cents = EXCLUDED.price_yearly_cents,
  quota_staff = EXCLUDED.quota_staff,
  quota_managers = EXCLUDED.quota_managers,
  quota_bookings_per_month = EXCLUDED.quota_bookings_per_month,
  quota_services = EXCLUDED.quota_services,
  features = EXCLUDED.features,
  active = EXCLUDED.active,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

-- ─── Team $100/mo ─────────────────────────────────────────────────
INSERT INTO plans (
  slug, name, description,
  price_monthly_cents, price_yearly_cents,
  quota_staff, quota_managers, quota_bookings_per_month, quota_services,
  features, active, sort_order
) VALUES (
  'team', 'Team', 'For growing teams that need scale, advanced reporting, and priority support.',
  10000, 110000,
  10, 1, -1, -1,
  '["10 staff seats","1 manager seat","Advanced reporting","Team analytics","Priority support","Advanced communications","Audit history","Export center"]'::jsonb,
  true, 30
) ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_monthly_cents = EXCLUDED.price_monthly_cents,
  price_yearly_cents = EXCLUDED.price_yearly_cents,
  quota_staff = EXCLUDED.quota_staff,
  quota_managers = EXCLUDED.quota_managers,
  quota_bookings_per_month = EXCLUDED.quota_bookings_per_month,
  quota_services = EXCLUDED.quota_services,
  features = EXCLUDED.features,
  active = EXCLUDED.active,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

-- ─── Enterprise $250/mo ───────────────────────────────────────────
INSERT INTO plans (
  slug, name, description,
  price_monthly_cents, price_yearly_cents,
  quota_staff, quota_managers, quota_bookings_per_month, quota_services,
  features, active, sort_order
) VALUES (
  'enterprise', 'Enterprise', 'For organizations that need unlimited scale, SSO, and a dedicated SLA.',
  25000, 275000,
  -1, -1, -1, -1,
  '["Unlimited staff","Unlimited managers","SSO / SAML","Enterprise SLA","Dedicated onboarding","White-label","Audit + governance exports","Advanced security controls","Priority phone support"]'::jsonb,
  true, 40
) ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_monthly_cents = EXCLUDED.price_monthly_cents,
  price_yearly_cents = EXCLUDED.price_yearly_cents,
  quota_staff = EXCLUDED.quota_staff,
  quota_managers = EXCLUDED.quota_managers,
  quota_bookings_per_month = EXCLUDED.quota_bookings_per_month,
  quota_services = EXCLUDED.quota_services,
  features = EXCLUDED.features,
  active = EXCLUDED.active,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

-- ─── Retire the wrongly-introduced 'business' slug ────────────────
-- We DEACTIVATE (active=false) rather than DELETE so any tenant
-- still pointing at current_plan='business' (e.g. seeded simulation
-- tenants from the prior wave) continues to resolve to a valid
-- plan row. Reset simulation will purge those tenants and the
-- 'business' row can later be hard-deleted if desired.
UPDATE plans SET active = false, updated_at = NOW()
 WHERE slug = 'business';

SELECT 1 AS pricing_correction_migration_applied;

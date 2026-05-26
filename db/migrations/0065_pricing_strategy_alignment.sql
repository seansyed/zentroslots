-- Pricing & Monetization Wave — plan row alignment.
--
-- Aligns DB-side plan rows with the operator's current strategy:
--   • Free        — free forever, 1 seat, 3 services
--   • Pro         — $10/mo (was $29) — solo professional tier
--   • Business    — NEW — mid-tier for teams (replaces undocumented
--                   gap between Pro and Enterprise)
--   • Enterprise  — custom pricing (price=0 = "contact sales")
--
-- Slug immutability: existing slugs are NEVER renamed. We UPDATE
-- existing rows in place by slug, INSERT only the new 'business'
-- slug. Tenants pointing at `current_plan='pro'` continue to
-- resolve correctly; their billing price has been adjusted to
-- match the new strategy.
--
-- Safety:
--   • Per-row ON CONFLICT DO UPDATE — re-running this migration
--     is idempotent.
--   • No tenant rows are touched. Existing subscriptions in
--     Stripe continue billing at whatever price they were
--     created with; this migration only updates the marketing /
--     reference values shown on /admin/plans and used by future
--     checkout sessions.

-- ─── Free ──────────────────────────────────────────────────────────
INSERT INTO plans (
  slug, name, description,
  price_monthly_cents, price_yearly_cents,
  quota_staff, quota_managers, quota_bookings_per_month, quota_services,
  features, active, sort_order
) VALUES (
  'free', 'Free', 'Get started with the essentials — free forever.',
  0, 0,
  1, 0, 50, 3,
  '["1 staff seat","Up to 3 active services","Public booking page","Basic reminders","Google Calendar","Basic communications"]'::jsonb,
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

-- ─── Pro ($10/mo) ──────────────────────────────────────────────────
INSERT INTO plans (
  slug, name, description,
  price_monthly_cents, price_yearly_cents,
  quota_staff, quota_managers, quota_bookings_per_month, quota_services,
  features, active, sort_order
) VALUES (
  'pro', 'Pro', 'For solo professionals — unlock branding, integrations, and embeds.',
  1000, 10000,
  3, 0, 2000, 50,
  '["3 staff seats","Unlimited services","Custom branding","Microsoft 365 + Zoom","Google Meet","Embed widget","Reminder workflows","Analytics","Email + SMS templates"]'::jsonb,
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

-- ─── Business (NEW) ────────────────────────────────────────────────
INSERT INTO plans (
  slug, name, description,
  price_monthly_cents, price_yearly_cents,
  quota_staff, quota_managers, quota_bookings_per_month, quota_services,
  features, active, sort_order
) VALUES (
  'business', 'Business', 'For teams — staff routing, departments, automation, executive analytics.',
  3900, 39000,
  15, 3, 10000, 200,
  '["15 staff seats","3 manager seats","Departments + routing","Follow-up automations","Executive analytics + reporting","Multiple locations","Custom domain","Advanced admin roles","Priority email support"]'::jsonb,
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

-- ─── Enterprise (custom pricing) ───────────────────────────────────
-- price_monthly_cents = 0 by convention means "contact sales".
-- The UI checks this sentinel and renders "Custom" / "Contact us"
-- instead of "$0/mo".
INSERT INTO plans (
  slug, name, description,
  price_monthly_cents, price_yearly_cents,
  quota_staff, quota_managers, quota_bookings_per_month, quota_services,
  features, active, sort_order
) VALUES (
  'enterprise', 'Enterprise', 'Custom — SLA, SSO, white-label, audit exports, dedicated onboarding.',
  0, 0,
  -1, -1, -1, -1,
  '["Unlimited staff + managers","SSO / SAML","Enterprise SLA","White-label","Audit + governance exports","Advanced security controls","Priority phone support","Dedicated onboarding"]'::jsonb,
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

SELECT 1 AS pricing_alignment_migration_applied;

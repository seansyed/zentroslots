-- 0012 — Super-admin operations: plans, promotions, announcements.
-- Strictly additive. Existing tenants/users/billing logic untouched.
BEGIN;

-- ─── Plans ──────────────────────────────────────────────────────────────
-- Editable pricing catalog managed via the super-admin UI. Each row is a
-- self-contained plan definition; tenants link to a plan via the existing
-- `tenants.current_plan` slug column (no schema change there).
CREATE TABLE IF NOT EXISTS plans (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                     varchar(40)  NOT NULL UNIQUE,
  name                     varchar(120) NOT NULL,
  description              text,
  price_monthly_cents      integer NOT NULL DEFAULT 0,
  price_yearly_cents       integer NOT NULL DEFAULT 0,
  stripe_price_id_monthly  varchar(120),
  stripe_price_id_yearly   varchar(120),
  quota_staff              integer NOT NULL DEFAULT 1,
  quota_bookings_per_month integer NOT NULL DEFAULT 100,
  quota_services           integer NOT NULL DEFAULT 5,
  features                 jsonb   NOT NULL DEFAULT '[]'::jsonb,
  active                   boolean NOT NULL DEFAULT true,
  sort_order               integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plans_active_idx ON plans(active);
CREATE INDEX IF NOT EXISTS plans_sort_idx   ON plans(sort_order);

-- Seed defaults so the UI isn't empty on first load. INSERT-only — does
-- nothing if rows already exist with these slugs.
INSERT INTO plans (slug, name, description, price_monthly_cents, price_yearly_cents,
                   quota_staff, quota_bookings_per_month, quota_services,
                   features, sort_order)
VALUES
  ('free',       'Free',       'Solo operators starting out.',         0,     0,
                                1,   50,  3,
                                '["1 staff seat","50 bookings/mo","Public booking page","Email reminders"]'::jsonb, 0),
  ('pro',        'Pro',        'Small teams that need real scheduling.',
                                2900, 29000, 10, 1000, 25,
                                '["10 staff seats","1,000 bookings/mo","Google Meet","Custom branding","Embed widget","Reminders 24h+1h"]'::jsonb, 10),
  ('enterprise', 'Enterprise', 'Multi-location operations + SLA.',
                                9900, 99000, 100, 100000, 200,
                                '["Unlimited staff","100k bookings/mo","Custom domain","White-label","Webhooks","Priority support","SLA"]'::jsonb, 20)
ON CONFLICT (slug) DO NOTHING;

-- ─── Promotions / coupons ───────────────────────────────────────────────
-- Marketing codes — applied at signup or upgrade. Three discount shapes:
-- percent off (e.g. 20% off first 3 months), fixed amount off (cents off
-- monthly invoice), or trial extension (add N days to current trial).
CREATE TABLE IF NOT EXISTS promotions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  varchar(40) NOT NULL UNIQUE,
  description           text,
  -- 'percent' | 'fixed' | 'trial_extension'
  kind                  varchar(20) NOT NULL,
  percent_off           smallint,            -- 1..100, used when kind='percent'
  amount_off_cents      integer,             -- used when kind='fixed'
  trial_extension_days  smallint,            -- used when kind='trial_extension'
  applies_to_plan       varchar(40),         -- nullable = applies to any plan
  max_redemptions       integer,             -- nullable = unlimited
  redemption_count      integer NOT NULL DEFAULT 0,
  starts_at             timestamptz,
  expires_at            timestamptz,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promotions_active_idx  ON promotions(active);
CREATE INDEX IF NOT EXISTS promotions_expires_idx ON promotions(expires_at);

-- ─── Announcements ──────────────────────────────────────────────────────
-- Platform-wide notices shown to tenant admins. Audience filter lets us
-- target free vs paid plans, or 'all'. The dashboard banner picks the
-- most recent active announcement matching the viewer's plan.
CREATE TABLE IF NOT EXISTS announcements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           varchar(200) NOT NULL,
  body            text NOT NULL,
  -- 'info' | 'warning' | 'critical'
  severity        varchar(20) NOT NULL DEFAULT 'info',
  -- 'all' | plan slug ('free','pro','enterprise')
  audience        varchar(40) NOT NULL DEFAULT 'all',
  link_url        text,
  link_label      varchar(80),
  published_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS announcements_active_idx    ON announcements(active);
CREATE INDEX IF NOT EXISTS announcements_audience_idx  ON announcements(audience);
CREATE INDEX IF NOT EXISTS announcements_published_idx ON announcements(published_at DESC);

COMMIT;

-- Wave H Phase 1 — tenant payment provider vault.
--
-- Architecture: ZentroMeet does NOT operate as a marketplace. Each
-- tenant brings their own Stripe / PayPal account; we store the
-- credentials encrypted and instantiate the provider's SDK with those
-- credentials per booking. Money flows tenant ↔ customer directly;
-- ZentroMeet never appears in the funds path.
--
-- Strictly additive. Zero impact on:
--   • Platform subscription billing (tenants paying ZentroMeet)
--   • Existing paid-booking lifecycle (pre-Wave-H bookings)
--   • The PLATFORM Stripe key (STRIPE_SECRET_KEY) — still used
--     exclusively for ZentroMeet's own SaaS subscriptions
--
-- Rollback: DROP TABLE on the three new tables + DROP COLUMN on the
-- two new columns. Pre-migration behavior intact.

-- ─── Credential vault ──────────────────────────────────────────────────
-- One row per (tenant, provider, mode). Secrets stored AES-256-GCM
-- encrypted via the existing lib/crypto.ts v1: envelope (the same
-- proven primitive used for OAuth refresh tokens since Wave A).
--
-- Two-mode design: tenants can configure live + test in parallel.
-- The partial unique index below enforces exactly one default per
-- (tenant, mode) so the booking flow can resolve unambiguously.
CREATE TABLE IF NOT EXISTS tenant_payment_providers (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- 'stripe' today; 'paypal' lands in Phase 2; 'square'/'authorize_net'
  -- additive in future. Kept as varchar (not enum) so future
  -- additions don't require enum migration.
  provider                  VARCHAR(20) NOT NULL,

  -- 'live' or 'test'. Tenant can have both for the same provider.
  mode                      VARCHAR(10) NOT NULL DEFAULT 'live',

  -- Tenant-chosen friendly name shown in their dashboard
  -- ("Production Stripe", "Test PayPal", etc.). Never used as a
  -- credential — pure display.
  account_label             VARCHAR(120) NOT NULL DEFAULT '',

  -- ── Credentials (sensitive) ──
  -- All values stored as v1: envelopes from lib/crypto.encryptSecret.
  -- secret_encrypted is the master credential: Stripe secret key,
  -- PayPal client_secret. Never decrypted on a read path that
  -- returns to the client — only on a server-side provider call.
  secret_encrypted          TEXT NOT NULL,

  -- ── Semi-public identifiers ──
  -- Stripe publishable key (safe to expose to the tenant's customers
  -- in embedded checkout if we ever ship it). PayPal client_id.
  -- Stored plaintext so the UI can show them without decrypting.
  publishable_key           TEXT,
  client_id                 TEXT,

  -- Webhook signing secret for THIS provider (Stripe whsec_…;
  -- PayPal webhook_id). Encrypted because some providers consider
  -- it a credential. Set in a second step after the tenant configures
  -- the webhook in their provider's dashboard.
  webhook_secret_encrypted  TEXT,

  -- ── Connection state ──
  -- 'pending'  : credentials saved but never successfully validated
  -- 'verified' : last validateCredentials() returned ok
  -- 'invalid'  : last validateCredentials() failed (auth, network, etc.)
  -- 'disabled' : tenant disabled this provider; not deleted
  status                    VARCHAR(20) NOT NULL DEFAULT 'pending',
  last_verified_at          TIMESTAMPTZ,
  last_error                TEXT,
  last_error_at             TIMESTAMPTZ,

  -- Provider-reported capabilities snapshot. Populated by the adapter
  -- during validateCredentials(). Schema-free jsonb so each provider
  -- can record its own shape (Stripe: { country, default_currency,
  -- charges_enabled, payouts_enabled, currencies, account_id };
  -- PayPal: { merchant_id, business_email, currencies }).
  capabilities              JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Selection: exactly one default per (tenant, mode) via partial
  -- unique index below. UI surfaces this as the "Default for live
  -- bookings" / "Default for test bookings" toggle.
  is_default                BOOLEAN NOT NULL DEFAULT false,

  -- Soft toggle. Disabled providers aren't picked for new bookings
  -- but their rows + history are preserved for audit.
  enabled                   BOOLEAN NOT NULL DEFAULT true,

  -- Surfaces "last paid event 2h ago" in the dashboard health card
  -- without joining tenant_payment_webhook_events on every page load.
  -- Updated by the webhook receiver (Phase 4) on every classified
  -- 'paid' event for this provider.
  last_payment_event_at     TIMESTAMPTZ,

  -- Audit
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,

  -- One row per (tenant, provider, mode). Re-saving a provider
  -- overwrites the existing row in place rather than creating a
  -- duplicate.
  UNIQUE (tenant_id, provider, mode)
);

-- Partial unique index: enforces exactly one default per
-- (tenant, mode). Toggling default must happen in a transaction:
-- 1) UPDATE … SET is_default = false WHERE tenant_id = ? AND mode = ?
-- 2) UPDATE … SET is_default = true  WHERE id = ?
-- Wrapped in db.transaction by lib/payments/connections.ts.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_payment_providers_default
  ON tenant_payment_providers (tenant_id, mode)
  WHERE is_default = true;

-- Hot path: list all enabled providers for a tenant on the Settings
-- → Payments page render.
CREATE INDEX IF NOT EXISTS tenant_payment_providers_tenant_enabled_idx
  ON tenant_payment_providers (tenant_id)
  WHERE enabled = true;

-- ─── Webhook event log per tenant ──────────────────────────────────────
-- Append-only audit of every webhook hit, scoped per-tenant. Separate
-- from the existing processed_stripe_events table (which dedupes the
-- PLATFORM's own subscription webhooks). The unique constraint on
-- (provider_id, external_event_id) gives us idempotent dedup across
-- replays without colliding with the platform table.
CREATE TABLE IF NOT EXISTS tenant_payment_webhook_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id         UUID NOT NULL REFERENCES tenant_payment_providers(id) ON DELETE CASCADE,
  provider            VARCHAR(20) NOT NULL,
  external_event_id   VARCHAR(255) NOT NULL,
  event_type          VARCHAR(80) NOT NULL,
  -- Set when the classifier resolved a booking; null when the event
  -- doesn't carry booking metadata (e.g. a generic account.updated).
  booking_id          UUID,
  -- Lifecycle of the event AT OUR INGESTION LAYER:
  --   'received'         : signature verified, awaiting dispatch
  --   'processed'        : dispatch completed (booking updated / no-op)
  --   'invalid_signature': verifyWebhook returned null
  --   'replay'           : (provider_id, external_event_id) collision
  --   'unhandled'        : event_type isn't one we act on
  status              VARCHAR(20) NOT NULL,
  error               TEXT,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_id, external_event_id)
);

CREATE INDEX IF NOT EXISTS tenant_payment_webhook_events_tenant_idx
  ON tenant_payment_webhook_events (tenant_id, received_at DESC);

CREATE INDEX IF NOT EXISTS tenant_payment_webhook_events_booking_idx
  ON tenant_payment_webhook_events (booking_id)
  WHERE booking_id IS NOT NULL;

-- ─── Booking ↔ provider linkage ────────────────────────────────────────
-- Identifies WHICH provider row was used to create the checkout for
-- a given booking. NULL means: legacy platform-charge path (pre-Wave-H
-- behavior; preserved unchanged for tenants who haven't opted in).
-- Webhook receiver uses this column to validate that an incoming
-- event's provider matches what created the booking — prevents
-- cross-provider spoofing.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS payment_provider_id UUID
    REFERENCES tenant_payment_providers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bookings_payment_provider_idx
  ON bookings (payment_provider_id)
  WHERE payment_provider_id IS NOT NULL;

-- ─── Per-tenant feature flag ───────────────────────────────────────────
-- Single boolean: when true, the booking POST routes paid bookings
-- through the tenant's own provider. When false (default), the
-- existing platform-charge code path runs unchanged. Allows safe
-- opt-in rollout per tenant in Phase 6.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS use_tenant_payment_providers BOOLEAN NOT NULL DEFAULT false;

-- Wave H Phase 2 — additive health + webhook-verification metadata.
--
-- Strictly additive on tenant_payment_providers. Every column has a
-- safe default so pre-Phase-2 rows transparently behave as
-- "unconfigured webhook + empty health snapshot". Rollback is
-- DROP COLUMN on the five columns; no data loss for Phase 1 state.
--
-- Why separate `health` from the existing `capabilities` column?
--   • `capabilities` is the result of validateCredentials() — the
--     provider's view of what the merchant account can do (country,
--     default_currency, charges_enabled, etc.). Refreshed on every
--     Test Connection.
--   • `health` is OUR operational view — recent latency, last
--     error class, periodic re-validation results, etc. Refreshed by
--     workers + the dashboard. Keeping them split prevents one
--     overwriting the other.

ALTER TABLE tenant_payment_providers
  -- Lifecycle of THIS provider's webhook configuration:
  --   'unconfigured' : webhook_secret_encrypted IS NULL (default)
  --   'configured'   : webhook secret saved but never received an event
  --   'verified'     : last received event verified its signature OK
  --   'failing'      : last received event signature FAILED
  ADD COLUMN IF NOT EXISTS webhook_status VARCHAR(20) NOT NULL DEFAULT 'unconfigured',

  -- Last time a webhook signature verified successfully. Set by the
  -- Phase 4 receiver on a verified event. The dashboard shows this
  -- next to the "Webhook" health pill: "Verified 5 min ago".
  ADD COLUMN IF NOT EXISTS last_webhook_verified_at TIMESTAMPTZ,

  -- Last verification failure message (redacted). The receiver writes
  -- adapter-supplied messages here, which have already passed
  -- through their adapter's redactSecrets() (see Stripe adapter
  -- helper). Bounded by code to 500 chars.
  ADD COLUMN IF NOT EXISTS last_webhook_error TEXT,
  ADD COLUMN IF NOT EXISTS last_webhook_error_at TIMESTAMPTZ,

  -- ZentroMeet's own operational view of this provider's recent
  -- behavior. Adapter + worker write into this:
  --   • lastValidateLatencyMs : ms taken on the last validate call
  --   • lastValidateAt        : when that validate ran
  --   • recentEventCount24h   : webhook events accepted last 24h
  --   • recentFailureCount24h : webhook events rejected last 24h
  -- Schema-free jsonb so adapters can record provider-specific shape
  -- (e.g. PayPal merchant-status snapshot) without a migration.
  ADD COLUMN IF NOT EXISTS health JSONB NOT NULL DEFAULT '{}'::jsonb;

-- No new indexes: webhook_status is low-cardinality and only queried
-- in conjunction with tenant_id (already indexed via the
-- tenant_enabled partial index from migration 0050). last_payment
-- _event_at and the new last_webhook_verified_at are surfaced per-
-- row in the dashboard, not aggregated.

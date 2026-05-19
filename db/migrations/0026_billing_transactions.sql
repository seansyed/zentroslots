-- 0026 — Canonical billing ledger.
--
-- Strictly additive. Captures Stripe webhook events as immutable
-- (or update-in-place for refund flips) rows. Tenants without any
-- Stripe traffic see byte-identical behavior — the new webhook
-- cases only INSERT when a row arrives.
--
-- Idempotency:
--   * Partial unique on stripe_event_id WHERE NOT NULL — Stripe
--     re-deliveries become 23505 → swallowed by the handler.
--   * Partial unique on stripe_payment_intent_id WHERE NOT NULL —
--     prevents the same PI from being inserted twice via different
--     event paths (payment_intent.succeeded + invoice.payment_succeeded
--     both reference a PI).
BEGIN;

CREATE TABLE IF NOT EXISTS billing_transactions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Stripe identifiers (all nullable — manual adjustments and
  -- non-Stripe refunds need not have them).
  stripe_event_id             varchar(120),
  stripe_invoice_id           varchar(120),
  stripe_payment_intent_id    varchar(120),
  stripe_customer_id          varchar(120),
  -- Internal links (nullable — a refund or adjustment may not map
  -- to a specific booking/subscription).
  customer_id                 uuid,
  booking_id                  uuid,
  subscription_id             uuid,
  -- Money. Stripe gives us cents as integers; bigint for headroom.
  amount_cents                bigint NOT NULL,
  currency                    varchar(8) NOT NULL DEFAULT 'usd',
  -- 'booking_payment' | 'subscription_payment' | 'invoice_payment'
  -- | 'refund' | 'adjustment' | 'credit'
  transaction_type            varchar(30) NOT NULL,
  -- 'pending' | 'paid' | 'failed' | 'refunded' | 'partially_refunded'
  status                      varchar(20) NOT NULL,
  paid_at                     timestamptz,
  refunded_at                 timestamptz,
  metadata                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Analytics access patterns: by tenant + paid_at (date scans), by
-- tenant + status (failed/refunded breakdowns), by tenant + type.
CREATE INDEX IF NOT EXISTS billing_transactions_tenant_paid_idx
  ON billing_transactions(tenant_id, paid_at);
CREATE INDEX IF NOT EXISTS billing_transactions_tenant_status_idx
  ON billing_transactions(tenant_id, status);
CREATE INDEX IF NOT EXISTS billing_transactions_tenant_type_idx
  ON billing_transactions(tenant_id, transaction_type);
CREATE INDEX IF NOT EXISTS billing_transactions_booking_idx
  ON billing_transactions(booking_id) WHERE booking_id IS NOT NULL;

-- Stripe retry idempotency — webhook handler swallows 23505.
CREATE UNIQUE INDEX IF NOT EXISTS billing_transactions_event_unique
  ON billing_transactions(stripe_event_id)
  WHERE stripe_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS billing_transactions_pi_unique
  ON billing_transactions(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL
    AND transaction_type IN ('booking_payment', 'subscription_payment', 'invoice_payment');

COMMIT;

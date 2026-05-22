-- Phase 4 of billing enforcement — Stripe webhook idempotency.
--
-- Stripe retries failed webhook deliveries with exponential backoff for
-- up to 3 days. Network blips, slow ledger writes, or restarting a PM2
-- worker mid-handler can cause the same event_id to arrive multiple
-- times. The signature stays valid across retries — every duplicate
-- would re-execute the tenants.update if we don't dedupe.
--
-- This table is the dedup boundary: at the top of the webhook handler
-- we `INSERT ... ON CONFLICT DO NOTHING`. If the row was already
-- present (i.e., we already processed this event_id), we skip the
-- switch entirely and return 200.
--
-- The companion `billing_transactions` ledger has its own unique index
-- on `stripe_event_id` and survives duplicates via a 23505 swallow.
-- This table extends the guarantee to ALL events — including
-- subscription.created/updated/deleted which the ledger doesn't track.
--
-- Retention: the table is bounded by the Stripe retry horizon (~3
-- days). Older rows can be pruned by a follow-up cron when the
-- governance retention engine runs. For now the table is small and
-- safe to leave indefinitely — duplicate-detection over a year is
-- still correct, just slightly more storage.

CREATE TABLE IF NOT EXISTS processed_stripe_events (
  -- Stripe event_id is the natural primary key. They look like
  -- "evt_1AbCdEf..." and are globally unique per Stripe account.
  event_id    varchar(120) PRIMARY KEY,
  -- Event type for debugging ("customer.subscription.updated", etc).
  event_type  varchar(120) NOT NULL,
  -- Optional tenant scoping for audit grep ("which events touched
  -- this tenant?"). NULL when we couldn't resolve the tenant.
  tenant_id   uuid REFERENCES tenants(id) ON DELETE SET NULL,
  -- Wall-clock when our handler claimed the event.
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Index for the audit grep — "show every Stripe event for this tenant"
-- runs against this table.
CREATE INDEX IF NOT EXISTS processed_stripe_events_tenant_idx
  ON processed_stripe_events(tenant_id);

-- Index for retention pruning ("DELETE WHERE processed_at <
-- now() - interval '30 days'").
CREATE INDEX IF NOT EXISTS processed_stripe_events_processed_at_idx
  ON processed_stripe_events(processed_at);

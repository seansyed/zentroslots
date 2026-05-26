# Runbook — Billing mismatch / double-charge / missed renewal

## When to use this

- Customer reports "I was charged twice."
- Customer reports "I paid but my plan still shows free."
- `/api/admin/billing/validate` flags `duplicate_charges`,
  `orphan_subscriptions`, or `desynced_status`.

## Triage

### 1. Run the validator

```bash
curl -s -H "Cookie: $SUPER_ADMIN_SESSION" https://app.zentromeet.com/api/admin/billing/validate | jq .
```

Or visit `/admin/ops` and `/admin/finance` directly.

### 2. Pull the tenant's billing history

```sql
SELECT id, action, actor_label, metadata, created_at
FROM audit_logs
WHERE tenant_id = 'TENANT_ID_HERE'
  AND (action LIKE 'billing.%' OR action LIKE 'subscription.%' OR action LIKE 'stripe%')
ORDER BY created_at DESC
LIMIT 30;

SELECT id, status, amount_cents, currency, stripe_payment_intent_id, created_at
FROM billing_transactions
WHERE tenant_id = 'TENANT_ID_HERE'
ORDER BY created_at DESC
LIMIT 30;

SELECT id, plan, subscription_status, stripe_subscription_id, trial_end, current_plan
FROM tenants WHERE id = 'TENANT_ID_HERE';
```

### 3. Pull the Stripe truth

Stripe Dashboard → Customers → search the email. Compare:
- Stripe `subscription.status` vs `tenants.subscription_status`.
- Stripe `customer.balance` (should be 0 in normal state).
- Stripe `invoices` list vs our `billing_transactions` rows.

## Recovery scenarios

### Double-charge confirmed

1. Stripe Dashboard → identify the duplicate `charge_xxx`.
2. Refund via Stripe (use "Duplicate" reason code so the chargeback
   risk drops).
3. Update our records:
   ```sql
   UPDATE billing_transactions SET status='refunded', updated_at=NOW()
   WHERE id = 'TRANSACTION_ID' AND status='succeeded';

   INSERT INTO audit_logs (tenant_id, action, actor_label, metadata) VALUES
    ('TENANT_ID', 'billing.refund.manual', 'operator:YOUR_NAME',
     '{"reason": "duplicate_charge", "amount_cents": N, "stripe_charge": "ch_..."}');
   ```
4. Send the customer a refund confirmation (Stripe does this
   automatically; you can also email a personal note).

### Customer paid, plan didn't upgrade

1. Confirm Stripe sees the subscription as active.
2. Check our subscriptions table for a stuck row:
   ```sql
   SELECT * FROM tenants WHERE id = 'TENANT_ID';
   ```
3. Force-sync from Stripe via the recon path:
   - Either trigger the webhook replay (Stripe Dashboard → Events →
     resend the original `customer.subscription.updated`).
   - Or run manually: `npx tsx scripts/reconcile-tenant-payments.ts TENANT_ID`.
4. If still wrong, manually update + audit:
   ```sql
   UPDATE tenants
   SET plan='pro', current_plan='pro', subscription_status='active', updated_at=NOW()
   WHERE id = 'TENANT_ID';

   INSERT INTO audit_logs (tenant_id, action, actor_label, metadata) VALUES
    ('TENANT_ID', 'billing.plan.manual_sync', 'operator:YOUR_NAME',
     '{"from": "free", "to": "pro", "reason": "missed webhook"}');
   ```

### Renewal missed (active becomes past_due unexpectedly)

1. Stripe Dashboard → Customers → look at the invoice that failed.
2. Common cause: card expired / 3DS challenge unanswered.
3. Send the customer the Stripe-hosted "Update payment method" URL:
   - Get it via `stripe customers retrieve cus_xxx | jq .invoice_settings.default_payment_method`.
   - Or use Stripe Customer Portal: enable in Stripe Dashboard →
     Settings → Customer portal → enable + share the link.
4. Once the customer updates their card, Stripe auto-retries the
   invoice. Status flips back to `active`.

### Tenant on paid plan but Stripe has no active sub (orphan)

```sql
-- Confirm orphan state
SELECT id, plan, subscription_status, stripe_subscription_id, stripe_customer_id
FROM tenants WHERE id = 'TENANT_ID';
```

Options:
- **Reactivate** (if customer intends to pay): create a new
  subscription in Stripe via the dashboard, then update the
  `stripe_subscription_id` on our row.
- **Downgrade** (if customer canceled and didn't tell us): set
  `plan='free'`, `current_plan='free'`, `subscription_status=NULL`,
  null out the Stripe IDs. Audit.

### Refund triggered a partial state

Stripe partial refunds don't auto-cancel subscriptions. Our
webhook handler ignores partial refunds (audit only). If the
customer expects a partial refund AND a plan change:

1. Refund in Stripe (partial or full).
2. Manually set the tenant's plan to the new tier:
   ```sql
   UPDATE tenants SET plan='free', current_plan='free' WHERE id='TENANT_ID';
   ```
3. Audit with the Stripe refund id.

## Reconciliation cron

`scripts/reconcile-tenant-payments.ts` walks every tenant's Stripe
subscription against our local state and surfaces drift. Run
nightly via cron, or on demand:

```bash
npx tsx scripts/reconcile-tenant-payments.ts
# or scoped:
TENANT_ID=xxx npx tsx scripts/reconcile-tenant-payments.ts
```

Output goes to stdout + `audit_logs` with action
`billing.reconciliation.drift_detected`.

## Verification

```bash
# Run the validator again after the fix
curl -s -H "Cookie: $SUPER_ADMIN_SESSION" https://app.zentromeet.com/api/admin/billing/validate | jq '.summary'
# Expected: critical=0, warnings=0 (or only intentionally-deferred items)

# Confirm the tenant's row is sane
psql "$DATABASE_URL" -c "SELECT id, plan, subscription_status, trial_end FROM tenants WHERE id='TENANT_ID';"
```

## After-action

1. Email the customer (use a personal note, not a templated one).
2. Document in `docs/operations/incidents/`.
3. Audit log entry with `ops.billing_repair` action.
4. If the same class of mismatch happens >1× in 30 days → root cause
   the webhook handler and add an automated test.

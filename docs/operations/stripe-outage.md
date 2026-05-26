# Runbook — Stripe outage / webhook lag

## When to use this

- Customers report "Pay Now" button hangs or returns generic error.
- `/api/health` shows `stripe.connectivity: false`.
- `/admin/finance` shows MRR flat for >1 hour (no new charges).
- Stripe status page is red: https://status.stripe.com/.

## Triage steps (run in order)

### 1. Confirm it's Stripe, not us

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.stripe.com/v1/charges \
  -u "$STRIPE_SECRET_KEY:"
```

- `200` → Stripe is up. Look at our code path.
- `5xx` → Stripe is down. Check https://status.stripe.com/.
- `401` → Our key is broken — see `.env` rotation steps below.

### 2. Check our webhook receiver

```bash
# Last successful Stripe webhook
psql "$DATABASE_URL" -c "SELECT MAX(received_at), COUNT(*) FILTER (WHERE received_at > NOW() - INTERVAL '1 hour') AS last_hour FROM tenant_payment_webhook_events WHERE status='processed';"

# Recent signature failures
psql "$DATABASE_URL" -c "SELECT received_at, status, payload_event_id FROM tenant_payment_webhook_events WHERE status='invalid_signature' AND received_at > NOW() - INTERVAL '2 hours' ORDER BY 1 DESC LIMIT 20;"
```

- If `last_hour=0` and Stripe is up → check Stripe dashboard:
  Developers → Webhooks → look for "failed delivery" attempts.
- If `invalid_signature` rows >0 → the webhook secret in `.env`
  is wrong or the tenant secret rotated.

### 3. Check our outbound calls

```bash
pm2 logs scheduling-saas --err --lines 100 --nostream | grep -i stripe
```

Look for repeated `StripeAPIError`, `StripeConnectionError`, or
timeouts on `paymentIntents.create`.

## Recovery

### If Stripe is down (confirmed via their status page)

**Do nothing.** Stripe's retry mechanism kicks in:
- Failed `paymentIntents.create` calls retry 3× with exponential backoff in our gateway.
- Webhook deliveries are retried by Stripe for up to 3 days.

Inform customers:
> "Payments are temporarily unavailable due to an upstream provider
> incident. We'll resume processing automatically once Stripe is
> stable — no action needed on your part."

### If our key is wrong (401 from Stripe)

1. SSH to the box: `ssh -i ~/.ssh/AATSKeyPair.pem ubuntu@35.83.95.42`.
2. Back up `.env`: `cp .env .env.bak.$(date +%Y%m%dT%H%M%S)`.
3. Rotate via Stripe Dashboard → Developers → API Keys → "Roll
   secret key."
4. Update `STRIPE_SECRET_KEY` in `.env`.
5. `pm2 restart scheduling-saas --update-env`.
6. `curl -s https://app.zentromeet.com/api/health | jq .checks.tenant_payment_vault`.

### If webhook secret is wrong (invalid_signature spike)

1. Stripe Dashboard → Developers → Webhooks → select the endpoint.
2. Click "Reveal" on the signing secret.
3. Update `STRIPE_WEBHOOK_SECRET` in `.env`.
4. `pm2 restart scheduling-saas --update-env`.
5. Replay the failed events from Stripe dashboard → "Failed
   deliveries" → "Resend." Up to 1000 at a time.

### If a tenant-specific webhook is broken (Wave H custom Stripe)

The platform supports tenants charging on their OWN Stripe account.
If only one tenant is affected:

```sql
SELECT id, provider, account_label, webhook_status, last_webhook_error_at, last_webhook_error_message
FROM tenant_payment_providers WHERE tenant_id = 'TENANT_ID_HERE';
```

If `webhook_status='failing'`, the tenant needs to:
1. Log into their workspace → Settings → Payments.
2. Click "Reconnect" on the Stripe provider.
3. Re-paste the webhook secret if Stripe forced a rotation.

## Verification (run after recovery)

```bash
# Bring a test charge through end-to-end:
stripe trigger payment_intent.succeeded

# Confirm our receiver processed it:
psql "$DATABASE_URL" -c "SELECT * FROM tenant_payment_webhook_events ORDER BY received_at DESC LIMIT 5;"

# Confirm /api/health flips green:
curl -s https://app.zentromeet.com/api/health | jq '.ok, .checks.tenant_payment_vault'
```

## After-action

1. Write up the incident in the audit log:
   ```sql
   INSERT INTO audit_logs (action, actor_label, metadata)
   VALUES ('ops.incident_resolved', 'operator:YOUR_NAME',
           '{"incident": "stripe_outage", "duration_min": N, "impact": "..."}');
   ```
2. Note in `docs/operations/incidents/` (create file
   `YYYY-MM-DD-stripe-outage.md`).
3. Confirm finance reports are accurate via `/admin/finance` →
   Stripe reconciliation panel.

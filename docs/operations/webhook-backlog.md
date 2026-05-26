# Runbook — Webhook backlog (Stripe / payment vault)

## When to use this

- `/api/health` shows `tenant_payment_vault.metrics.pendingPaymentBacklog > 0`.
- `/admin/ops` shows "Pending-payment bookings overdue".
- Customers report "I paid but my booking says pending."

## Triage

### 1. Find the stuck rows

```sql
SELECT id, tenant_id, status, payment_hold_expires_at, payment_provider_id, start_at,
       EXTRACT(EPOCH FROM (NOW() - payment_hold_expires_at))::int / 60 AS overdue_min
FROM bookings
WHERE status = 'pending_payment'
  AND payment_hold_expires_at < NOW() - INTERVAL '5 minutes'
ORDER BY payment_hold_expires_at ASC
LIMIT 50;
```

### 2. Check the cron heartbeat

```sql
SELECT job_name, status, started_at, finished_at, detail
FROM cron_runs
WHERE job_name = 'holds:expire'
ORDER BY started_at DESC
LIMIT 10;
```

- If no rows / last row > 10 min ago → cron is not running.
- If `status='failed'` → check `detail.error`.

### 3. Verify cron is in crontab

```bash
crontab -l | grep holds:expire
```

Expected: `*/5  * * * * cd /var/www/scheduling-saas && /usr/bin/npm run holds:expire >> /var/log/scheduling-saas/holds-expire.log 2>&1`

If missing → add via `crontab -e`.

## Recovery

### Drain the backlog manually

```bash
ssh -i ~/.ssh/AATSKeyPair.pem ubuntu@35.83.95.42
cd /var/www/scheduling-saas
npm run holds:expire
```

Output: `[holds] candidates=N ok=N failed=0 stale=N`. If `failed>0`,
check the stdout log lines for per-row error.

### Repair an individual stuck booking

If a customer's booking is stuck AND they did successfully pay (Stripe
shows the charge but we never received the webhook):

```sql
-- Confirm the Stripe charge exists by looking up the payment_intent
-- via the Stripe dashboard, then manually transition:

BEGIN;
UPDATE bookings SET status = 'confirmed', payment_hold_expires_at = NULL, updated_at = NOW()
WHERE id = 'BOOKING_ID_HERE' AND status = 'pending_payment';
-- Verify exactly 1 row affected before committing
COMMIT;

-- Audit the manual fix:
INSERT INTO audit_logs (tenant_id, action, actor_label, entity_type, entity_id, metadata) VALUES
 ('TENANT_ID', 'ops.manual_booking_repair', 'operator:YOUR_NAME', 'booking', 'BOOKING_ID',
  '{"reason": "Stripe payment succeeded but webhook never arrived", "stripe_payment_intent": "pi_..."}');
```

### Webhook never arriving for new bookings

1. Stripe Dashboard → Developers → Webhooks → endpoint details.
2. Look for "Failed deliveries" — these are pending retries.
3. Click "Resend" on each failed event up to 3 days old.
4. If endpoint shows "disabled" → re-enable + restart pm2 if our
   server was unreachable.

### Per-tenant Stripe (Wave H custom payment vault)

```sql
SELECT id, provider, account_label, status, webhook_status, last_webhook_error_message
FROM tenant_payment_providers
WHERE tenant_id = 'TENANT_ID_HERE';
```

If `webhook_status='failing'` for a single tenant:
- The TENANT's Stripe webhook endpoint is broken, not ours.
- Have them log in → Settings → Payments → click "Reconnect."

## Verification

```bash
# Confirm backlog cleared
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM bookings WHERE status='pending_payment' AND payment_hold_expires_at < NOW() - INTERVAL '5 minutes';"
# Expected: 0

# Confirm cron is running again
psql "$DATABASE_URL" -c "SELECT job_name, status, started_at FROM cron_runs WHERE job_name='holds:expire' ORDER BY started_at DESC LIMIT 5;"
# Expected: status='ok' rows within last 10 min

# Confirm /api/health
curl -s https://app.zentromeet.com/api/health | jq '.checks.tenant_payment_vault'
# Expected: ok=true, pendingPaymentBacklog=0
```

## Prevention

- The `holds:expire` cron now self-alerts via `payment_hold_backlog`
  admin notification when any row is overdue >10 minutes.
- The `cron_runs` table is the canonical record of "did the cron
  actually run." `/admin/ops` surfaces it visually.

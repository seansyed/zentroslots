# Operations — Scheduling SaaS

Day-to-day running of the platform. See [DEPLOYMENT.md](./DEPLOYMENT.md) for shipping it and [INCIDENT.md](./INCIDENT.md) for when things break.

## Daily

- **Health:** verify `GET /api/health` returns 200. Watch for `bookings_no_overlap` ever flipping to `ok: false` — that's a critical alert.
- **Email failures:** Super-admin dashboard `/admin` shows 7-day email-failure count. If non-zero, check the audit log (`/dashboard/emails`) for tenant context.
- **Audit log signal:** sort `audit_logs` by `created_at DESC LIMIT 50` and skim. Watch for repeated `email.failed`, `booking.create` falling off, or unusual `auth.login` IPs.

## Weekly

- **Backups verified:** restore the latest dump to a throwaway DB and run `psql -c "\dt"` — confirm all tables exist.
- **Reminders cron alive:** check the last 7 days of `bookings.reminder_24h_sent_at` / `reminder_1h_sent_at` should be evenly distributed. A gap means the cron stopped.
- **Stripe sync:** if `STRIPE_SECRET_KEY` is set, spot-check that any subscription state change in Stripe shows up in `tenants.subscription_status`.

## Monthly

- **Cost review:** check Postgres + email provider usage.
- **Logs retention:** trim `audit_logs` older than 90 days if it gets large. Indexed delete:
  ```sql
  DELETE FROM audit_logs WHERE created_at < now() - interval '90 days';
  ```

## Quarterly

- **Restore drill:** full restore from backup → run smoke test (see DEPLOYMENT.md §6).
- **Dependency review:** `npm outdated`. Pay attention to security advisories on `next` and Stripe SDK.
- **Rate limit review:** check audit logs for 429 patterns; tune `lib/rate-limit.ts` capacities.

## On-call signals (what should page someone)

| Signal | Severity | Action |
|---|---|---|
| `/api/health` returns 503 for >2 min | P1 | Check DB, check process, check EXCLUDE constraint |
| Stripe webhook 4xx rate >5% over 15 min | P2 | Verify `STRIPE_WEBHOOK_SECRET` hasn't been rotated |
| Email failure rate >10% over 1 hour | P2 | Verify email provider creds + DNS (SPF/DKIM) |
| Booking creation 5xx rate >1% | P1 | Likely engine or DB issue; check logs for `booking_no_overlap` violations becoming common |
| Reminder cron silent for >24h | P2 | Server scheduler/cron is broken, restart it |

## Logs to know

The structured logger writes JSON lines. Useful greps:

```bash
# Email pipeline issues
journalctl -u scheduling-saas | grep '"lvl":"error"' | grep email

# Slow handlers (logger.time wraps record ms latency)
journalctl -u scheduling-saas | grep ':ok' | jq 'select(.ms > 1000)'

# Google reconnect events
journalctl -u scheduling-saas | grep google_status

# Failed Stripe webhook signatures (intentionally noisy if Stripe replay-testing)
journalctl -u scheduling-saas | grep 'Stripe webhook signature'
```

## Common ops tasks

### Mark a tenant Pro manually (when Stripe is in demo mode)

```sql
UPDATE tenants
SET current_plan = 'pro', subscription_status = 'active'
WHERE slug = 'acme-tax';
```

### Reset a tenant's Google connection flag

```sql
UPDATE users
SET google_status = NULL, google_last_error_at = NULL
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'acme-tax')
  AND role = 'staff';
```

### Snapshot daily booking volume

```sql
SELECT date_trunc('day', created_at) AS day, COUNT(*)
FROM bookings
WHERE created_at > now() - interval '30 days'
GROUP BY 1 ORDER BY 1;
```

### Look up everything about one booking

```sql
SELECT b.*, s.name AS service, u.name AS staff, t.name AS tenant
FROM bookings b
JOIN services s ON s.id = b.service_id
JOIN users u ON u.id = b.staff_user_id
JOIN tenants t ON t.id = b.tenant_id
WHERE b.id = 'xxx';

SELECT * FROM audit_logs WHERE entity_id = 'xxx' ORDER BY created_at;
```

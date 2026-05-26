# ZentroMeet Production Operations Runbooks

Each runbook is a self-contained guide for diagnosing and recovering
from a specific class of production incident. They are written
**for a tired operator at 3am** — no assumptions of context, every
command copy-pasteable, every "if X then Y" branch explicit.

## Index

| File | Use when |
|---|---|
| [stripe-outage.md](./stripe-outage.md) | Stripe API is returning 5xx or webhooks aren't arriving. |
| [ses-failures.md](./ses-failures.md) | Emails are failing — bounces, suppression, or hard send errors. |
| [webhook-backlog.md](./webhook-backlog.md) | tenant_payment_webhook_events backlog growing. |
| [queue-failures.md](./queue-failures.md) | Cron worker stopped running, or stuck-job recovery. |
| [oauth-outages.md](./oauth-outages.md) | Google/Microsoft tokens en-masse expiring. |
| [worker-crashes.md](./worker-crashes.md) | PM2 process crashing repeatedly. |
| [deployment-rollback.md](./deployment-rollback.md) | A deploy broke production — how to revert. |
| [db-failover.md](./db-failover.md) | RDS unavailable, slow queries, connection saturation. |
| [billing-mismatch-recovery.md](./billing-mismatch-recovery.md) | Tenant claims wrong plan, double-charge, missed renewal. |

## Severity / response priority

| Severity | Examples | Response time |
|---|---|---|
| P0 — Customer-facing outage | App down, all payments failing, all emails failing | Drop everything |
| P1 — Customer impact, partial | One tenant's payments broken, one cron stalled | < 1 hour |
| P2 — No customer impact yet | Backlog growing, queue depth elevated | < 4 hours |
| P3 — Hygiene | Stale logs, retention overdue | Next business day |

## Generic checklist for any incident

1. **Read the headline first.** `curl -s https://app.zentromeet.com/api/health | jq .` —
   what's flagged?
2. **Pull pm2 logs.** `pm2 logs scheduling-saas --err --lines 80 --nostream`
3. **Pull cron run history.** Open `/admin/ops` in the super-admin
   dashboard — every cron's last-run state is there.
4. **Check the audit log.** `SELECT action, COUNT(*), MAX(created_at) FROM audit_logs WHERE created_at > NOW() - INTERVAL '1 hour' GROUP BY 1 ORDER BY 2 DESC LIMIT 30;`
5. **Communicate.** Even if it's just "I'm looking at it" — the team
   needs to know nothing is being missed.

## Operator credentials & access

- **SSH:** `ssh -i ~/.ssh/AATSKeyPair.pem ubuntu@35.83.95.42`
- **Project:** `/var/www/scheduling-saas/`
- **PM2 process:** `scheduling-saas` (id 0, fork mode, port 3001)
- **DB:** RDS Postgres. Connection string in `.env` → `DATABASE_URL`.
- **Stripe:** live + test keys in `.env`. Stripe CLI for replay:
  `stripe events resend evt_xxx`.

## Communication channels

- **Customer-facing:** status.zentromeet.com (TBD), Twitter/X, email.
- **Internal:** Slack #ops (TBD).
- **Audit log:** Every operator action that mutates state MUST land
  a `audit_logs` row with `actor_label='operator:<name>'` and a
  human-readable `metadata.reason`.

## Anti-runbook (things NOT to do)

- ❌ **Never** `git reset --hard origin/main` on the server without
  first backing up uncommitted state (`/tmp/server-uncommitted-*.patch`).
  Phase 16 redesign work was edited directly on the server for days;
  blind resets have lost work before.
- ❌ **Never** `pm2 reload` (cluster-mode reload may keep stale
  workers). Use `pm2 restart scheduling-saas --update-env`.
- ❌ **Never** skip `npm run build` before pm2 restart — Next.js
  serves the OLD `.next/` artifact otherwise.
- ❌ **Never** issue refunds outside Stripe's dashboard during an
  incident — the audit trail is cleaner that way.
- ❌ **Never** drop a DB index without a corresponding `CREATE INDEX
  CONCURRENTLY` plan — exclusive locks kill the app.

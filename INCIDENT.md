# Incident response — Scheduling SaaS

If something is broken in production. Pairs with [OPERATIONS.md](./OPERATIONS.md).

## Triage checklist (do these in order)

1. **Confirm impact.** Open `/api/health` and the super-admin `/admin` dashboard. Are bookings being created? (Check 7-day count card.)
2. **Identify scope.** One tenant, many, all?
3. **Pull recent audit log.**
   ```sql
   SELECT created_at, action, tenant_id, metadata
   FROM audit_logs
   ORDER BY created_at DESC
   LIMIT 100;
   ```
4. **Communicate.** If user-facing, post a status update before debugging — every minute of silence costs trust.

## Common scenarios

### "Bookings aren't being created"

```bash
# 1. Health check
curl -sf https://app.example.com/api/health | jq

# 2. Look for slot-discovery 500s
journalctl -u scheduling-saas --since "10m ago" | grep "API error"

# 3. Check whether the EXCLUDE constraint is rejecting more than usual
#    (409 'Slot just taken' is normal; sudden spike means races)
journalctl -u scheduling-saas --since "1h ago" | grep "Slot just taken" | wc -l
```

If `bookings_no_overlap` shows ok:false in health → migrate **immediately**:
```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    staff_user_id WITH =,
    tstzrange(start_at, end_at) WITH &&
  ) WHERE (status = 'confirmed');
```

### "Reminders stopped sending"

The reminder cron is a separate process (Windows Task Scheduler / Linux cron). The app itself doesn't know if it's alive.

```bash
# Manual run — catches up any missed reminders (idempotent)
cd /app && npm run reminders:send
```

If sends succeed, restart the scheduler entry. The `reminder_24h_sent_at` and `reminder_1h_sent_at` columns guard against double-firing.

### "Google Calendar broken for one tenant"

Look for the tenant in `/admin` → Integration health. Each affected staff user has `users.google_status = 'expired'`. They need to **reconnect Google** via their dashboard — the banner is already visible to them.

To force-clear the flag (e.g. after manual debugging):
```sql
UPDATE users SET google_status = NULL, google_last_error_at = NULL
WHERE id = '<staff user id>';
```

### "Stripe webhook signatures are failing"

```bash
# Verify env: secret must match the Stripe dashboard endpoint signing secret
echo "$STRIPE_WEBHOOK_SECRET" | head -c 20

# Replay last failed event from Stripe CLI
stripe events resend evt_xxx --webhook-endpoint we_xxx
```

The route logs `Stripe webhook signature verification failed:` with the raw error.

### "Emails stopped delivering"

```bash
# Check provider
journalctl -u scheduling-saas --since "30m ago" | grep '"provider"'
# → "resend" / "postmark" / "smtp" / "stub"

# Check failure rate in last hour
psql "$DATABASE_URL" -c "
  SELECT action, COUNT(*) FROM audit_logs
  WHERE created_at > now() - interval '1 hour'
    AND action IN ('email.sent', 'email.failed')
  GROUP BY action;"
```

If using Resend or Postmark, check the provider dashboard for bounces / domain issues (SPF / DKIM).

If everything points to the provider being down: temporarily swap to SMTP by unsetting `RESEND_API_KEY` / `POSTMARK_TOKEN` and restart. The fallback chain is automatic: Resend → Postmark → SMTP → stub.

### "Public booking page is loading but slot grid is empty"

Most common cause: the **viewer's day** intersected with the **staff's working window** is empty. Check:

1. Does the staff have weekly availability for that day-of-week? (`/dashboard/availability`)
2. Are there overrides that block the date? (`/dashboard/availability/overrides`)
3. Is the date in the past? The engine excludes past slots.

The engine is the single source of truth — it never returns slots the constraint would reject.

### "Database is overloaded"

Look for slow queries in logs (`logger.time` wraps record ms > 1000ms):

```bash
journalctl -u scheduling-saas | jq 'select(.ms? > 1000)' | head -50
```

Common culprits:
- Calendar route on a tenant with thousands of bookings → add date-range filter to the page query
- Audit log query on a tenant with millions of entries → ensure the partial indexes exist

## Rollback decision tree

| Symptom | Action |
|---|---|
| New deploy regresses booking flow | `pm2 reload` to previous image, then debug |
| Migration broke things | Apply the **reverse** migration (manual; you wrote it before applying) |
| Stripe is firing duplicate webhooks | Webhook is idempotent; ignore |
| One tenant's data is wrong | Use the SQL snippets in OPERATIONS.md to repair; never apply changes globally |

## Postmortem template

After resolution, file a postmortem in `incidents/<date>-<short-name>.md`:

```
# <Incident title>

**Date:** YYYY-MM-DD
**Duration:** HH:MM – HH:MM (X minutes)
**Severity:** P1/P2/P3
**Impact:** how many tenants, what they couldn't do

## Timeline
- HH:MM — Detected via …
- HH:MM — Investigated …
- HH:MM — Identified root cause as …
- HH:MM — Mitigation deployed
- HH:MM — All-clear confirmed

## Root cause
What actually broke.

## What went well
Detection, response, etc.

## What went poorly
Slow detection, missing runbook, etc.

## Action items
- [ ] OWNER — change to prevent recurrence
- [ ] OWNER — improve runbook / monitoring
```

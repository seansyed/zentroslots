# Runbook — Cron / queue failures

ZentroMeet is currently cron-based (no BullMQ/Redis queue). All
background work flows through the npm scripts in `scripts/` invoked
by ubuntu user's crontab. This runbook covers the failure modes.

## Triage — start at /admin/ops

`/admin/ops` shows every cron's heartbeat, color-coded:
- **OK** (green) — last run within expected interval.
- **Stale** (amber) — last run between 3× and 6× the interval.
- **Down** (red) — no run for >6× the interval, or last run failed.
- **Unknown** (gray) — job is known but has never run on this DB.

Click into any row to see `cron_runs.detail` (per-tick counters,
error reason).

## Common failure modes

### 1. Cron stopped running

```bash
crontab -l | head -30
```

If the expected line is missing → add via `crontab -e`. Reference
`docs/operations/README.md` for the full list of expected jobs.

```bash
# Verify cron daemon is alive
sudo systemctl status cron
```

### 2. Cron is running but failing every time

```sql
SELECT started_at, status, detail
FROM cron_runs
WHERE job_name = 'JOB_NAME_HERE' AND status = 'failed'
ORDER BY started_at DESC LIMIT 10;
```

Look at `detail->>'error'` for the message. Common categories:

- **DB connection failure** → check `.env` `DATABASE_URL`, then
  `psql "$DATABASE_URL" -c "SELECT 1;"`.
- **OOM** → the EC2 instance is small (1.9GB). Run a single cron at
  a time during high-volume periods (avoid analytics:aggregate +
  scheduled-reports:generate simultaneously).
- **Code regression** — a recent deploy broke the worker. Roll back
  per `deployment-rollback.md`.

### 3. Stuck jobs (claim-flip orphans)

For `run-automations.ts` and similar workers that claim rows via
`UPDATE … RETURNING`:

```sql
-- Find rows stuck in 'processing' for >30 min — the claiming worker
-- crashed before flipping to 'sent' or 'failed'.
SELECT id, tenant_id, status, updated_at
FROM pending_automations
WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '30 minutes';

-- Reset to 'pending' so the next cron tick picks them up.
UPDATE pending_automations SET status = 'pending', updated_at = NOW()
WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '30 minutes';
```

### 4. Cron is duplicated (multi-instance)

We run a single PM2 fork process. If we ever scale to multiple
instances WITHOUT first migrating to a distributed queue (BullMQ +
Redis), crons will double-execute.

**Mitigation today:** crontab runs on the EC2 box only. Don't
deploy a second instance until BullMQ migration ships. The
audit document `STABILIZATION_AUDIT_2026-05-26.md` tracks this
gap.

## Manual override — run a cron once

Every cron is exposed as an npm script. From the box:

```bash
ssh -i ~/.ssh/AATSKeyPair.pem ubuntu@35.83.95.42
cd /var/www/scheduling-saas

npm run holds:expire             # drain payment holds
npm run reminders:send           # send pending reminders
npm run automations:run          # process follow-up queue
npm run waitlists:expire         # release waitlist reservations
npm run recurring:materialize    # materialize occurrences
npm run analytics:aggregate      # rebuild yesterday's snapshot
npm run scheduled-reports:generate
npm run governance:retention
npm run feeds:sync               # external ICS feeds
npm run admin:snapshots:hourly   # super-admin hourly snapshot
npm run admin:snapshots:daily
npm run admin:snapshots:tenant
npm run admin:snapshots:finance
```

All of these write a `cron_runs` row when wrapped via
`withCronRun()`. Output goes to stdout in structured JSON.

## Backfill missed work

If a cron was missing for hours:

```bash
# Reminders: re-runs are idempotent — only sends what hasn't been sent.
npm run reminders:send

# Snapshots: backfill prior N days.
BACKFILL_DAYS=7 npm run admin:snapshots:daily
BACKFILL_HOURS=24 npm run admin:snapshots:hourly

# Recurring series materialization: re-runs are idempotent.
npm run recurring:materialize
```

## Verification

```bash
psql "$DATABASE_URL" -c "SELECT job_name, status, started_at FROM cron_runs WHERE started_at > NOW() - INTERVAL '1 hour' ORDER BY started_at DESC LIMIT 30;"
```

Then visit `/admin/ops` and confirm every job shows OK.

# Runbook — PM2 worker crashes / process flapping

## When to use this

- `pm2 status` shows the `scheduling-saas` process restarted N times
  in a row with no manual intervention.
- /api/health returns 502 / 503 intermittently.
- `pm2 logs scheduling-saas --err --lines 100 --nostream` shows
  uncaught exceptions, OOM errors, or SIGKILL signals.

## Triage

```bash
ssh -i ~/.ssh/AATSKeyPair.pem ubuntu@35.83.95.42
pm2 status
pm2 logs scheduling-saas --err --lines 200 --nostream
```

Look for:
- `JavaScript heap out of memory` → OOM, see below.
- `Error: connect ECONNREFUSED` → DB unreachable, see `db-failover.md`.
- Unhandled promise rejection from a third-party library → see
  "Code regression" below.
- `EADDRINUSE :3001` → port collision (another process taking it).

## Recovery

### OOM crash

The EC2 box is small (1.9GB RAM). Indicators:
- `Allocation failed - JavaScript heap out of memory`
- `pm2 status` shows mem column climbing >900MB before each restart.

Mitigations:
1. **Restart now**: `pm2 restart scheduling-saas --update-env`.
2. **Cap Node heap**: edit pm2 ecosystem file, set
   `NODE_OPTIONS="--max-old-space-size=1024"` so Node fails fast
   instead of consuming swap.
3. **Find the leak**: take a heap snapshot via
   `pm2 sendSignal SIGUSR2 scheduling-saas` (PM2 writes a heap dump
   to `/tmp/`). Analyze offline with Chrome DevTools.
4. **Workaround**: scale the EC2 instance vertically (t3.small →
   t3.medium). One-line change in AWS Console; ≤5 min downtime.

### Uncaught exception storm

If the process keeps booting and dying within the first N seconds:

1. `pm2 stop scheduling-saas` — get the box back to a quiet state.
2. Run the app in foreground to see the FULL error:
   ```bash
   cd /var/www/scheduling-saas
   npm run start
   # Watch stdout for the first stack trace.
   ```
3. Common causes:
   - **Missing env var.** App reads `process.env.X` at module init
     and throws. Add the var to `.env`, restart.
   - **DB schema drift.** Recent migration didn't apply, code is
     reading a column that doesn't exist. Apply the migration and
     restart.
   - **Broken import.** A `dist/*.js` artifact is stale. Run
     `npm run build` then `pm2 restart`.

### Code regression after deploy

See `deployment-rollback.md` for the full procedure.

Quick version:
```bash
cd /var/www/scheduling-saas
git log --oneline -5
git reset --hard <PREVIOUS_GOOD_COMMIT>
npm install --no-audit --no-fund
npm run build
pm2 restart scheduling-saas --update-env
```

### Port already in use

```bash
sudo lsof -i :3001
# Kill the stale process
sudo kill -9 <PID>
pm2 restart scheduling-saas --update-env
```

## PM2 hygiene

```bash
# View startup commands + env
pm2 show scheduling-saas

# Save current state so it survives EC2 reboot
pm2 save

# Confirm pm2 startup is configured
pm2 startup
```

## Verification

```bash
# Process up?
pm2 status

# Process responding?
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/api/health

# No new crashes in last 5 min?
pm2 logs scheduling-saas --err --lines 50 --nostream | grep -i 'error\|crash'
```

## After-action

- Document the crash in `docs/operations/incidents/`.
- Update `audit_logs` with the manual restart action.
- If memory ceiling was hit, file a follow-up to investigate the
  memory leak instead of indefinitely living with `--max-old-space-size`.

# Runbook — Deployment rollback

## When to use this

- A deploy broke production: 5xx spike, UI showing console errors,
  booking flow failing.
- `/api/health` flipped from green to red shortly after a deploy.
- A regression is suspected but you don't have time to diagnose —
  revert first, investigate after.

## Pre-rollback safety

ALWAYS take 30 seconds to capture state before reverting:

```bash
ssh -i ~/.ssh/AATSKeyPair.pem ubuntu@35.83.95.42
cd /var/www/scheduling-saas

# Capture the bad commit hash + diff in case we need it.
git log --oneline -5 > /tmp/bad-deploy-$(date +%Y%m%dT%H%M%S).txt

# Snapshot any uncommitted local edits.
git status --short
git diff > /tmp/server-uncommitted-$(date +%Y%m%dT%H%M%S).patch

# Back up .env (some deploys edit it).
cp .env .env.bak.predeploy-rollback-$(date +%Y%m%dT%H%M%S)
```

## Rollback

```bash
# 1. Find the previous good commit.
git log --oneline -10
# Identify the commit BEFORE the bad one.

# 2. Reset to it.
git reset --hard <PREVIOUS_GOOD_COMMIT_SHA>

# 3. Rebuild the artifact (CRITICAL — pm2 restart alone won't pick
#    up the older code if .next/ still has the bad build).
npm install --no-audit --no-fund
npm run build

# 4. Restart.
pm2 restart scheduling-saas --update-env

# 5. Wait + verify.
sleep 3
curl -s https://app.zentromeet.com/api/health | jq '.ok'
pm2 logs scheduling-saas --lines 10 --nostream
```

## Rolling back a migration

DB migrations are forward-only. There is no `drizzle migrate down`.
If a migration shipped data corruption:

1. **Stop writes** if possible — set `MAINTENANCE_MODE=1` in `.env`
   and restart pm2 (handler checks this and returns 503 to writes).
2. **Take a manual DB backup** before doing anything:
   ```bash
   pg_dump "$DATABASE_URL" > /tmp/rollback-snapshot-$(date +%Y%m%dT%H%M%S).sql
   ```
3. **Write a reverse migration** with the explicit DDL to undo the
   damage. Land it as `db/migrations/00XX_revert_NN.sql`. Apply
   manually via `psql`.
4. **Document** the rollback in `docs/operations/incidents/` with
   the exact statements run.

NEVER edit / delete a previously-applied migration file. The
migration runner uses file modification time + checksums — editing
files in place will desync the migration state across environments.

## Force-deploy a hotfix

When you need to ship a small targeted fix without going through
the full PR flow:

```bash
# On your laptop:
cd C:/Trae/ZentroBizApp-EC2/ZentroBizProduction/scheduling-saas
# Make the fix.
npx tsc --noEmit            # MUST pass
npm run build               # MUST pass
git add <files>
git commit -m "hotfix: <description>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin main

# On the server:
ssh -i ~/.ssh/AATSKeyPair.pem ubuntu@35.83.95.42
cd /var/www/scheduling-saas
cp .env .env.bak.predeploy-$(date +%Y%m%dT%H%M%S)
git fetch origin
git reset --hard origin/main
npm install --no-audit --no-fund
npm run build
pm2 restart scheduling-saas --update-env
curl -s https://app.zentromeet.com/api/health | jq '.ok'
```

## Verification

```bash
# /api/health is green
curl -s https://app.zentromeet.com/api/health | jq '.ok, .checks | length'

# Bookings can be created (smoke test from booking page)
curl -s -o /dev/null -w "%{http_code}\n" https://app.zentromeet.com/u/test-workspace

# /api/admin/* still 404 to unauthenticated (security check)
curl -s -o /dev/null -w "%{http_code}\n" https://app.zentromeet.com/api/admin/ops
# Expected: 404

# No new errors in pm2 logs
pm2 logs scheduling-saas --err --lines 30 --nostream
```

## After-action

1. Document the incident: `docs/operations/incidents/YYYY-MM-DD-rollback.md`.
2. Open a PR to forward-fix the root cause on `main`.
3. Audit:
   ```sql
   INSERT INTO audit_logs (action, actor_label, metadata) VALUES
    ('ops.deployment_rollback', 'operator:YOUR_NAME',
     '{"from_commit": "X", "to_commit": "Y", "reason": "...", "duration_min": N}');
   ```
4. Postmortem: what should we have caught in CI? Add a test that
   would have caught the regression.

# Runbook — DB failover / slow queries / connection saturation

## When to use this

- `/api/health` shows `db.ok: false`.
- pm2 logs full of `Error: connect ECONNREFUSED` to the DB host.
- Booking flow times out at 30s with "Internal server error."
- RDS dashboard shows CPU >90% or connection count near limit.

## Triage

```bash
# 1. Can we reach the DB at all?
psql "$DATABASE_URL" -c "SELECT 1;"

# 2. Connection count vs limit
psql "$DATABASE_URL" -c "SELECT COUNT(*) AS connections, current_setting('max_connections')::int AS max FROM pg_stat_activity;"

# 3. Slow / blocking queries
psql "$DATABASE_URL" -c "SELECT pid, state, wait_event_type, wait_event, query_start, LEFT(query, 200) AS query FROM pg_stat_activity WHERE state != 'idle' ORDER BY query_start ASC LIMIT 20;"

# 4. Lock contention
psql "$DATABASE_URL" -c "SELECT * FROM pg_locks WHERE NOT granted;"
```

## Recovery

### RDS instance down (cannot reach at all)

1. AWS Console → RDS → confirm instance state.
2. If status is "Available" but unreachable, check:
   - Security group: does our EC2 still have ingress on 5432?
   - VPC peering: did something change in routing?
3. If status is "Failed" or "Storage-full":
   - Trigger automated failover via AWS Console (if Multi-AZ).
   - Otherwise, restore from latest automated snapshot.

### Connection saturation

If `pg_stat_activity` is close to `max_connections`:

1. Identify which app is hogging:
   ```sql
   SELECT application_name, COUNT(*)
   FROM pg_stat_activity GROUP BY 1 ORDER BY 2 DESC;
   ```
2. If pm2 process has too many open: restart it (cleanly closes).
   `pm2 restart scheduling-saas --update-env`.
3. If a stray `psql` session is wedged: `pg_terminate_backend(pid)`.
   Use sparingly.
4. Consider raising `max_connections` (RDS parameter group; requires
   reboot — schedule for maintenance window).

### Slow query starving the app

A single multi-minute query (e.g. an admin export running without
LIMIT) can starve connection pool.

```sql
-- Find queries running >60s
SELECT pid, query_start, NOW() - query_start AS duration, LEFT(query, 200) AS query
FROM pg_stat_activity
WHERE state = 'active' AND query_start < NOW() - INTERVAL '60 seconds';

-- Kill if confirmed safe
SELECT pg_cancel_backend(<PID>);
-- Or harder:
SELECT pg_terminate_backend(<PID>);
```

Investigate the source — likely a missing index. After the
incident, file a follow-up to add the index via `CREATE INDEX
CONCURRENTLY` (locking version is fatal in production).

### Lock contention

```sql
-- Show blocking + blocked pairs
SELECT
  blocking.pid AS blocking_pid,
  blocking.query AS blocking_query,
  blocked.pid AS blocked_pid,
  blocked.query AS blocked_query
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE NOT blocked.granted;
```

If a long transaction is holding row locks, cancel its backend.

## Read replicas

ZentroMeet uses a single primary today. If we ever add a read
replica:
- Read-heavy paths (admin analytics, dashboard reports) should
  point at the replica via a separate connection string.
- Writes always go to primary.
- Replica lag (`pg_last_wal_receive_lsn` vs primary) must stay <5s
  for the routing to be safe.

## Maintenance windows

RDS has nightly automated backups + a weekly maintenance window
(currently 03:00–04:00 UTC Saturdays). During maintenance:
- Backups: app unaffected, slight I/O degradation possible.
- Engine upgrades: brief connection drop (<60s). pm2's pg-pool
  auto-reconnects.

## Verification

```bash
# DB reachable
psql "$DATABASE_URL" -c "SELECT NOW();"

# Connection count back to normal
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM pg_stat_activity;"
# Expected: <50 in steady state

# App healthy
curl -s https://app.zentromeet.com/api/health | jq '.checks.db'
```

## Prevention

- Drizzle queries are parameterized — no SQL injection vector.
- All `db.execute(sql\`...\`)` blocks should have a tight WHERE
  clause and a LIMIT for unbounded read paths.
- Indexes audit: see `STABILIZATION_AUDIT_2026-05-26.md` for
  the running list of missing indexes.
- Long-running analytical queries → run via cron + snapshot table,
  never inline on a dashboard request.

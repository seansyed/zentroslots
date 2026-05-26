# Runbook — OAuth / calendar token outages

## When to use this

- `/api/health` shows `expired_tokens` count > 0 in security KPIs.
- Tenants report "Calendar disconnected" tile on Settings → Calendar.
- `calendar_sync_logs` filling with `status='error'` rows.
- Multiple tenants affected at once (suggests provider-side issue).

## Triage

### 1. Identify the scope

```sql
SELECT provider, status, COUNT(*)
FROM calendar_connections
WHERE status IN ('needs_reconnect', 'expired', 'error')
GROUP BY 1, 2
ORDER BY 3 DESC;
```

- One tenant → user-specific (revoked grant, password change).
- All tenants on one provider → that provider's API is degraded
  OR our OAuth app credentials rotated.

### 2. Check sync logs

```sql
SELECT provider, error_class, error_message, COUNT(*), MAX(created_at)
FROM calendar_sync_logs
WHERE status='error' AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY 1, 2, 3
ORDER BY 4 DESC
LIMIT 20;
```

Common `error_class` values:
- `auth` — token expired / revoked / invalid.
- `rate_limit` — Google/Microsoft throttling.
- `transient` — 5xx from provider; will retry next sync tick.
- `permanent` — calendar deleted, account suspended.

### 3. Check provider status

- Google Workspace: https://www.google.com/appsstatus/
- Microsoft 365: https://admin.microsoft.com/servicehealth
- Stripe (for OAuth refresh on payments): https://status.stripe.com/

## Recovery

### Single-tenant outage

The user must reconnect themselves:
1. They visit `/dashboard/settings/calendar` in their workspace.
2. The disconnected provider shows a red "Reconnect" tile.
3. They click → OAuth re-flow → new refresh token persisted.
4. Sync resumes automatically on next tick.

Send the tenant a one-paragraph email pointing them at the
reconnect URL (template in `lib/templates/calendar-reconnect.ts`).

### Provider-wide outage (Google or Microsoft down)

**Do nothing.** Our sync orchestrator (`lib/calendar/sync.ts`)
retries with backoff. When the provider returns, sync catches up on
the next cron tick.

Customer messaging:
> "External calendar sync (Google / Microsoft) is temporarily
> degraded due to a provider incident. New bookings are unaffected;
> they'll appear in your external calendar once sync resumes."

### Our OAuth app credentials rotated

If we accidentally rotated the Google or Microsoft OAuth app
credentials in the cloud console, ALL tenants will start failing
auth at once.

1. Restore the prior credentials from the cloud console history
   (Google Cloud Console keeps versions; Azure AD does too).
2. If restore isn't possible, you have to roll forward:
   - Update `.env` with the new `GOOGLE_CLIENT_ID`,
     `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`,
     `MICROSOFT_CLIENT_SECRET`.
   - `pm2 restart scheduling-saas --update-env`.
   - **Every tenant** with a connected calendar must reconnect
     manually. Send them a broadcast email via the announcement
     system at `/admin/announcements`.
3. Audit:
   ```sql
   INSERT INTO audit_logs (action, actor_label, metadata) VALUES
    ('ops.oauth_credentials_rotated', 'operator:YOUR_NAME',
     '{"provider": "google", "reason": "...", "affected_tenants": N}');
   ```

### Force a re-sync for a stuck tenant

```bash
# From the box:
ssh -i ~/.ssh/AATSKeyPair.pem ubuntu@35.83.95.42
cd /var/www/scheduling-saas

# Triggers the sync orchestrator for a specific tenant.
TENANT_ID=xxx-xxx npx tsx scripts/calendar-drift-scan.ts
```

The drift scan walks the calendar_connections rows for the tenant,
attempts a token refresh, runs the sync orchestrator, and updates
`status` per result.

## Verification

```bash
# Bring a sample connection back to verified
psql "$DATABASE_URL" -c "SELECT id, provider, status, last_synced_at FROM calendar_connections WHERE tenant_id='TENANT_ID' ORDER BY 4 DESC LIMIT 5;"

# Confirm /api/health
curl -s https://app.zentromeet.com/api/health | jq '.checks'
```

`/admin/security` IP intelligence panel also shows OAuth events
(success/failure ratio) — useful for confirming the broader fix.

## Prevention

- `lib/calendar/notifyReconnect.ts` already fires an admin-notify
  when a tenant flips to `needs_reconnect` — opt the on-call into
  the alert inbox.
- Booking creation NEVER blocks on calendar sync — a broken calendar
  is a degraded experience, not an outage.

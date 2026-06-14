# Cron / scheduled-job manifest

Single source of truth for **every** background job ZentroMeet expects to
run in production. Before launch, confirm each line below is registered on
the host (crontab, systemd timers, or a PM2 cron module). Prior to this
manifest only `reminders:send` was documented, so several jobs silently
never ran (calendar push-channel renewal, payment-hold expiry, waitlist
release, automations, recurring materialization, external-feed sync, push
delivery, analytics/admin snapshots).

> All jobs are idempotent and safe to overlap. Each `npm run <script>`
> maps to a `scripts/*.ts` file (see `package.json`). Logs append to
> `/var/log/zentromeet/<job>.log` — **set up logrotate** for that
> directory (see `OPERATIONS.md`).

## Why this matters at launch

| Job | If it does NOT run |
|---|---|
| `calendar:webhook-renew` | Google/Microsoft push channels expire (~7h–70h) and calendar sync **silently stops**; conflicts stop blocking slots → double-bookings. |
| `holds:expire` | Paid-booking soft-holds never release; slots stay locked after abandoned checkout. |
| `waitlists:expire` | Waitlist reservations never release; offers stall. |
| `reminders:send` | Customers get no appointment reminders → no-shows. |
| `push:deliver` | Queued push notifications never deliver. |
| `automations:run` | Follow-ups / review requests never fire. |
| `recurring:materialize` | Recurring appointments stop generating future instances. |
| `feeds:sync` | External (ICS) busy times go stale → double-booking risk. |
| `analytics:aggregate` / `admin:snapshots:*` | Dashboards/health show stale or "never aggregated". |
| `payments:reconcile` | Tenant payment-provider drift goes undetected. |

## crontab (example — adjust APP_DIR and node path to the host)

```cron
# m h dom mon dow   command   (APP_DIR=/var/www/scheduling-saas)
# --- High frequency ---
*/2 * * * *   cd /var/www/scheduling-saas && npm run push:deliver        >> /var/log/zentromeet/push.log 2>&1
*/5 * * * *   cd /var/www/scheduling-saas && npm run holds:expire        >> /var/log/zentromeet/holds.log 2>&1
*/5 * * * *   cd /var/www/scheduling-saas && npm run waitlists:expire    >> /var/log/zentromeet/waitlists.log 2>&1
*/10 * * * *  cd /var/www/scheduling-saas && npm run automations:run     >> /var/log/zentromeet/automations.log 2>&1
*/15 * * * *  cd /var/www/scheduling-saas && npm run reminders:send      >> /var/log/zentromeet/reminders.log 2>&1
*/15 * * * *  cd /var/www/scheduling-saas && npm run feeds:sync          >> /var/log/zentromeet/feeds.log 2>&1
# --- Hourly ---
0 * * * *     cd /var/www/scheduling-saas && npm run calendar:webhook-renew >> /var/log/zentromeet/cal-renew.log 2>&1
20 * * * *    cd /var/www/scheduling-saas && npm run freebusy:cleanup    >> /var/log/zentromeet/freebusy.log 2>&1
40 * * * *    cd /var/www/scheduling-saas && npm run admin:snapshots:hourly >> /var/log/zentromeet/snap-hourly.log 2>&1
# --- Several times a day ---
0 */6 * * *   cd /var/www/scheduling-saas && npm run calendar:drift      >> /var/log/zentromeet/cal-drift.log 2>&1
# --- Daily (early UTC, after midnight tenant rollover) ---
10 2 * * *    cd /var/www/scheduling-saas && npm run recurring:materialize >> /var/log/zentromeet/recurring.log 2>&1
20 2 * * *    cd /var/www/scheduling-saas && npm run analytics:aggregate >> /var/log/zentromeet/analytics.log 2>&1
30 2 * * *    cd /var/www/scheduling-saas && npm run admin:snapshots:daily >> /var/log/zentromeet/snap-daily.log 2>&1
40 2 * * *    cd /var/www/scheduling-saas && npm run scheduled-reports:generate >> /var/log/zentromeet/reports.log 2>&1
50 2 * * *    cd /var/www/scheduling-saas && npm run governance:retention >> /var/log/zentromeet/governance.log 2>&1
0 3 * * *     cd /var/www/scheduling-saas && npm run payments:reconcile  >> /var/log/zentromeet/payments.log 2>&1
# --- Only if custom domains (Cloudflare) are enabled ---
*/15 * * * *  cd /var/www/scheduling-saas && npm run domains:ssl         >> /var/log/zentromeet/domains.log 2>&1
```

## Verification after install

1. `crontab -l` shows every line above.
2. After one cycle, `GET /api/health` should show `reminder_delivery`,
   `expired_payment_holds`, `analytics_aggregation`, and
   `admin:snapshots` freshness all healthy.
3. Spot-check `/admin/ops` cron heartbeat — note it currently only
   instruments a subset of jobs (`cron_runs`); absence there does not
   prove a job is down. Confirm via the log files until heartbeat
   coverage is expanded.
4. With a real connected Google/Microsoft calendar, confirm the
   `webhook_channels` row's expiry advances after `calendar:webhook-renew`
   runs.

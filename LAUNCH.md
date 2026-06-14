# Launch readiness — Scheduling SaaS

Production checklist. Skim before going live; every box must be ticked.

## 1. Database

- [ ] Postgres 16+ with `btree_gist` extension available
- [ ] Apply migrations in order: `0000` → `0070` (full set in `db/migrations/`; note `0046` and `0049` are intentionally absent from the sequence)
- [ ] Verify constraints:
  - `bookings_no_overlap` (EXCLUDE) present
  - `availability_overrides_shape` CHECK present
  - `users_tenant_email_unique` UNIQUE present
- [ ] Daily managed backups enabled, point-in-time-recovery on
- [ ] Connection pool sized (we hit "too many clients" during dev with Next HMR — production set `max_connections` ≥ 200, application pool ≤ 50)
- [ ] Read replica optional — current scale doesn't require it

```sql
-- Quick sanity check
SELECT conname FROM pg_constraint WHERE conname = 'bookings_no_overlap';
SELECT count(*) FROM pg_indexes WHERE schemaname='public';
```

## 2. Environment variables

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (TLS in prod) |
| `JWT_SECRET` | yes | 32+ random bytes; `openssl rand -base64 32` |
| `APP_BASE_URL` | yes | Absolute URL, used in emails + OAuth + sitemap |
| `STRIPE_SECRET_KEY` | recommended | Without it, billing routes return 503 |
| `STRIPE_WEBHOOK_SECRET` | required if Stripe on | Webhook signature verification |
| `STRIPE_PRICE_SOLO_MONTH` / `_YEAR` | required if Stripe on | Stripe Price IDs for Solo (note the `_MONTH`/`_YEAR` suffix — see `.env.example`) |
| `STRIPE_PRICE_PRO_MONTH` / `_YEAR` | required if Stripe on | Stripe Price IDs for Pro |
| `STRIPE_PRICE_TEAM_MONTH` / `_YEAR` | required if Stripe on | Stripe Price IDs for Team |
| `STRIPE_PRICE_ENTERPRISE_MONTH` / `_YEAR` | required if Stripe on | Stripe Price IDs for Enterprise |
| `STRIPE_PRICE_PRO` / `STRIPE_PRICE_TEAM` | optional | Legacy monthly-only fallbacks for pre-Phase-16 subscriptions |
| `GOOGLE_CLIENT_ID` | optional | Google OAuth + Calendar |
| `GOOGLE_CLIENT_SECRET` | optional | Google OAuth + Calendar |
| `GOOGLE_REDIRECT_URI` | optional | Must match Google console exactly |
| `SMTP_HOST` | optional | Without it, emails log to console |
| `SMTP_PORT` | optional | Default 587 |
| `SMTP_USER` / `SMTP_PASS` | optional | If your SMTP requires auth |
| `EMAIL_FROM` | optional | e.g. `"Acme <hello@acme.com>"` |
| `SUPER_ADMIN_EMAILS` | optional | Comma-separated; grants access to `/admin` |

Validate by hitting `/api/billing/state` after login — `stripeConfigured: true` confirms keys are wired.

## 3. Stripe setup (test → live)

1. Create two Products + recurring Prices in Stripe dashboard (Pro, Team)
2. Add the price IDs to env
3. Configure the webhook endpoint: `POST {APP_BASE_URL}/api/webhooks/stripe`
4. Subscribe to events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`
6. Test with the Stripe CLI: `stripe trigger checkout.session.completed`
7. **Promote to live mode** — change secret key, price IDs, and webhook signing secret all together

## 4. Google OAuth setup

1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client (Web app)
2. Authorized redirect URI: `{APP_BASE_URL}/api/google/callback`
3. Enable APIs: **Google Calendar API**
4. OAuth consent screen → Add scopes (exact strings, must match runtime requests):
   - `openid`
   - `profile`
   - `email`
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
5. Add yourself as a test user until verified
6. Paste client ID + secret into env

## 5. DNS + TLS

- [ ] `app.your-domain.com` → app server (TLS required)
- [ ] (optional) wildcard `*.your-domain.com` for per-tenant subdomains (subdomain code is staged via `resolveTenantSlugFromRequest` — flip one function when ready)
- [ ] Set `APP_BASE_URL` to the canonical https URL
- [ ] HSTS header recommended at the proxy

## 6. Email deliverability

- [ ] SPF, DKIM, DMARC configured for the sending domain
- [ ] Test deliverability against Gmail + Outlook
- [ ] `.ics` attachment displays as "Add to calendar" in Gmail/Apple Mail
- [ ] If using a transactional provider (Resend / Postmark / SES), swap `SMTP_HOST` to the provider's relay

## 7. Scheduled jobs (cron)

> ⚠️ Reminders are only ONE of ~17 scheduled jobs. Register the COMPLETE
> set from **`docs/operations/cron-manifest.md`** — in particular
> `calendar:webhook-renew` (calendar sync silently dies without it),
> `holds:expire`, `waitlists:expire`, `automations:run`, `push:deliver`,
> `recurring:materialize`, and the analytics/admin-snapshot jobs.

- Linux: `*/15 * * * * cd /app && /usr/bin/node node_modules/.bin/tsx scripts/send-reminders.ts >> /var/log/reminders.log 2>&1`
- Windows Server: Task Scheduler → trigger every 15 minutes → action: `npm run reminders:send`
- Script is idempotent — overlap or double-fire is safe (the `reminder_*_sent_at` columns guard against duplicate sends)

## 8. Backups

- [ ] Automated nightly Postgres dump retained 30 days
- [ ] Weekly full snapshot retained 6 months
- [ ] Quarterly restore drill (verify a backup actually restores cleanly)
- [ ] Stripe data is owned by Stripe — no app-side backup needed

## 9. Observability

- Application logs: stdout (capture at the platform — Vercel logs, Fly Logs, CloudWatch, etc.)
- `[email:fail]` and `[audit] write failed` lines are the most useful signals to alert on
- Watch for `409 Slot just taken` rate as a leading indicator of race conditions
- Stripe webhook delivery dashboard — investigate any failure

## 10. Security review

| Check | Status |
|---|---|
| `JWT_SECRET` is 32+ bytes random | |
| Stripe webhook signature verified (raw body) | implemented |
| Rate limits on `/api/auth/login`, `/signup`, `/api/bookings` POST | implemented |
| Tenant scoping on every DB-touching route | reviewed |
| Public booking tokens are signed (HS256) with `purpose` claim | implemented |
| Email never blocks booking creation | implemented |
| Booking creation never blocks on Stripe/Google failures | implemented |
| Cookies are HttpOnly + Secure + SameSite=Lax in prod | implemented |
| Per-tenant unique email constraint | implemented |
| No raw user input in SQL (all via Drizzle) | reviewed |

## 11. Smoke test (run after deploy)

1. Marketing pages load: `/`, `/pricing`, `/features`, `/about`
2. Sign up as admin → onboarding wizard appears → finish
3. Connect Google Calendar (if configured)
4. Public profile loads at `/u/{slug}`
5. Book a slot in an incognito window → confirm email arrives with `.ics`
6. Click cancel link in the email → booking shows cancelled in dashboard
7. Upgrade to Pro via billing page (Stripe test mode)
8. Verify webhook fires + `currentPlan` updates
9. Hit rate limits intentionally — should get 429 + Retry-After
10. `/admin` returns 404 to non-superusers; loads cleanly with `SUPER_ADMIN_EMAILS` set

## 12. Rollback plan

- DB: keep last migration script + a manual reverse-migration handy
- App: previous release stays in container registry; one-click rollback
- Stripe: keep test mode wired in staging — never deploy a live-mode change without a staging dry run
- Email: switching providers is one env var change

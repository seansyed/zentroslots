# ZentroMeet — Final Web Launch Validation

**Date:** 2026-06-14
**Branch:** `launch-audit-fixes` → pushed to `origin` (`github.com/seansyed/zentroslots`)
**Head commit:** `a18a534` (local HEAD == `origin/launch-audit-fixes`, verified)
**Companion:** [`ZENTROMEET_LAUNCH_AUDIT_REPORT.md`](ZENTROMEET_LAUNCH_AUDIT_REPORT.md)

> ## Scope-of-execution disclosure (read first)
> This stabilization phase ran in a **development environment with no production access** — the local `.env` is a thin dev file (no DB, Stripe, SES, or Microsoft credentials), and there is **no SSH path to the EC2 host** and no live Google/Microsoft/Stripe/SES console access from here.
>
> Therefore I **fully executed** all work that is doable from the repository: code fixes, the OAuth CSRF hardening + tests, the production build, the typecheck, the full test suite, the secret/diff scan, the legal-page authoring, the config-as-code audit, and pushing the validated branch to GitHub.
>
> I **could not execute** the steps that require the production host or third-party consoles: the actual EC2 deploy, cron registration on the host, database backup/restore, and the live end-to-end smoke tests against real Google/Microsoft/Stripe/SES. For each of those I provide an **exact, ready-to-run runbook and verification command** rather than fabricating a "pass." Per the task's own rule 15 and the non-negotiable "no claim without evidence," those items are marked **OPERATOR-REQUIRED**, not GO.
>
> The final decision reflects this honestly: the code is launch-ready and validated, but production deploy + verification have not been performed here, so the decision is **CONDITIONAL GO**, not GO.

---

## 1. Exact commit deployed
- **Validated & pushed to GitHub:** `a18a534` on branch `launch-audit-fixes` (== `origin/launch-audit-fixes`, confirmed via `git rev-parse`).
- **Deployed to production:** **NOT YET** — requires merge to `main` + the host deploy process (OPERATOR-REQUIRED; runbook in §22).
- Branch contains 2 commits over `main`: `0e5921d` (audit fixes) + `a18a534` (build resilience + OAuth CSRF). 38 files, +1165/−98 (incl. the two report docs).
- PR: `gh` is not installed here; open at `https://github.com/seansyed/zentroslots/pull/new/launch-audit-fixes`.

## 2. Deployment timestamp
- Branch pushed to origin: 2026-06-14 (this session). Production deploy timestamp: **pending operator deploy.**

## 3. Backup confirmation
- **OPERATOR-REQUIRED — cannot verify from repo.** Before deploying, confirm a fresh DB dump exists and restores. Commands (run on the EC2 host):
  - `pg_dump "$DATABASE_URL" -Fc -f /var/backups/scheduling-saas/db-$(date +%F-%H%M).dump`
  - Verify restore into a scratch DB: `pg_restore --list /var/backups/.../db-*.dump | head`
  - Confirm RDS/managed automated backups + PITR window in the AWS console.
  - **Do not deploy without a current, restore-tested backup.**

## 4. Migration status
- **Repo:** migrations `0000–0070` present (`0046`, `0049` intentionally absent). The established apply mechanism is the **raw psql loop** (`for f in db/migrations/*.sql`), NOT drizzle-kit.
- **⚠️ Hazard honored (task rule 9/10):** I did **not** run `drizzle-kit push`/`migrate`/`generate` against anything — the Drizzle journal is frozen at `0000`, so a generic drizzle-kit migrate could drop/alter live tables. No schema changes were introduced by this branch.
- **OPERATOR-REQUIRED:** confirm `0066` (pricing) is applied in prod: `SELECT slug, price_monthly_cents FROM plans;` and the EXCLUDE constraint exists: `SELECT conname FROM pg_constraint WHERE conname='bookings_no_overlap';`

## 5. Build result
- **`next build` → PASS** (executed here). Earlier failures were real and fixed:
  - `/sitemap.xml` and `/book` were statically prerendered while querying Postgres → `ECONNREFUSED` at build. Both now `force-dynamic`; sitemap degrades gracefully on DB error. Build now completes and emits the full route manifest.
- Non-fatal warnings (pre-existing, documented, not blocking): `@sentry/node` not installed (dynamic import in `lib/logger.ts`); `nodeMiddleware` config-key warning (Next 15.5 moved it; middleware still loads — shown `✓ nodeMiddleware`); one invalid Tailwind utility.

## 6. PM2 status
- **OPERATOR-REQUIRED — cannot verify from repo.** After deploy: `pm2 status`, `pm2 show scheduling-saas` (confirm `online`, no restart loop), `pm2 save`, and `pm2 startup` (verify the systemd unit so it survives reboot). Recommendation: run **single-instance/fork** mode (the rate limiter + jti cache are in-process; cluster halves their effectiveness).

## 7. Health endpoint result
- **Code verified** (`app/api/health/route.ts`): 20+ DB-backed checks, hard-fails (503) on DB/EXCLUDE-constraint/governance/Cloudflare-if-configured, soft-fails on SMTP/Stripe/calendar so the booking engine stays up.
- **OPERATOR-REQUIRED (live):** `curl -fsS https://app.zentromeet.com/api/health | jq '.ok, .checks | keys'` → expect `ok:true` (200).

## 8. Cron registration table
The full manifest is in [`docs/operations/cron-manifest.md`](docs/operations/cron-manifest.md) (added this phase; previously only `reminders:send` was documented). npm scripts were added for the 5 previously-unwired jobs (incl. `calendar:webhook-renew`). **Registration on the host is OPERATOR-REQUIRED.**

| Job | npm script | Frequency | Why it matters | Lock/idempotency | Log |
|---|---|---|---|---|---|
| Reminders | `reminders:send` | */15m | no-show reduction | `reminder_*_sent_at` + comm-log unique | reminders.log |
| Payment-hold expiry | `holds:expire` | */5m | release abandoned-checkout slots | `WHERE status='pending_payment'` race guard | holds.log |
| Waitlist expiry | `waitlists:expire` | */5m | release reservations | transactional flip + race check | waitlists.log |
| Automations | `automations:run` | */10m | follow-ups/reviews | atomic claim `pending→processing` | automations.log |
| Push delivery | `push:deliver` | */2m | deliver notifications | backoff + dead-token drop | push.log |
| External feeds | `feeds:sync` | */15m | ICS busy-time freshness | soft-lock `next_sync_after` | feeds.log |
| **Calendar webhook renew** | `calendar:webhook-renew` | hourly | **calendar sync dies w/o it** (channels expire ~7–70h) | renews <6h to expiry | cal-renew.log |
| Calendar drift | `calendar:drift` | */6h | detect desync | per-run | cal-drift.log |
| Freebusy cleanup | `freebusy:cleanup` | hourly | cache hygiene | per-run | freebusy.log |
| Recurring materialize | `recurring:materialize` | daily | generate future instances | idempotent | recurring.log |
| Analytics aggregate | `analytics:aggregate` | daily | dashboards/health freshness | per-run | analytics.log |
| Admin snapshots | `admin:snapshots:hourly`/`:daily` | hourly/daily | super-admin KPIs | `cron_runs` | snap-*.log |
| Scheduled reports | `scheduled-reports:generate` | daily | tenant reports | per-run | reports.log |
| Governance retention | `governance:retention` | daily | data retention | per-run | governance.log |
| Payments reconcile | `payments:reconcile` | daily | provider drift detection | per-run | payments.log |
| Domains SSL (if custom domains) | `domains:ssl` | */15m | cert issuance | per-run | domains.log |

**Idempotency/overlap:** every job is idempotent; reschedule clears reminder flags so reminders re-arm to the new time; cancelled bookings are excluded from reminders by the `status='confirmed'` filter. **Do not register the same job in BOTH PM2 cron and system crontab** (duplicate execution). `last-run` evidence after install: `SELECT job_name, MAX(started_at) FROM cron_runs GROUP BY 1;` (note: heartbeat currently instruments only `holds:expire` + `push:deliver` — verify others via their log files until heartbeat coverage is expanded).

## 9. Public website test results
- **Code/build verified:** routes `/`, `/pricing`, `/features`, `/about`, `/privacy`, `/terms`, `/robots.txt`, `/sitemap.xml`, `/for/[vertical]` all build and resolve; footer now links Privacy/Terms/Support; login legal links resolve; trial over-claims removed; no mobile-app claim in marketing (verified by grep). **Live HTTP 200 checks are OPERATOR-REQUIRED** (`curl -I` each after deploy).

## 10. Signup test result
- **Code verified** (bcrypt cost 10, per-tenant unique email, session issued, new-tenant admin notice). **Live signup with a test tenant is OPERATOR-REQUIRED** (needs running app + DB). Smoke steps in §22.

## 11. Onboarding test result
- **Fixed + code-verified:** onboarding now auto-links the creator/admin as `serviceStaff` (both manual + template paths), adds a `no_staff` activation blocker, requires ≥1 working day, and provides a "Finish later" escape on the terminal step. This closes the prior P0 (workspace marked "live" but unbookable). **Live wizard run is OPERATOR-REQUIRED** (§22 smoke).

## 12. Booking test result
- **Code verified:** DST math, buffer/min-notice/horizon, conflict union, `EXCLUDE` double-booking backstop, 409 on race; paid-checkout `expires_at` 502 fixed. **Live booking (incognito) + email + calendar-event creation are OPERATOR-REQUIRED** (§22).

## 13. Google Calendar test result
- **Code verified + hardened:** OAuth connect/callback now use a single-use, httpOnly, constant-time, cookie-bound state nonce (CSRF fixed) on **both** the new and legacy Google routes; tokens AES-256-GCM encrypted; scopes aligned; user/tenant from session (unchanged). 9 unit tests pass. **Live connect → conflict-block → create → reschedule → cancel → disconnect/reconnect with a real Google account is OPERATOR-REQUIRED** (§22). Also confirm consent-screen verified + exact redirect URI in Google Console.

## 14. Microsoft Calendar test result
- **Code verified + hardened:** same CSRF nonce applied to the Microsoft calendar connect/callback; Graph adapter is complete (rolling refresh, Teams URL preserved, only-customer attendee). **Live test + Azure verification are OPERATOR-REQUIRED.** If publisher verification is still pending, the consent screen shows an "unverified" warning — document the exact screen and complete Azure: app registration, **both** redirect URIs, delegated scopes (`Calendars.ReadWrite`, `OnlineMeetings.ReadWrite`, `User.Read`, `offline_access`), publisher verification. **Not a launch blocker unless Outlook is promoted** (the pricing FAQ currently says "on the roadmap").

## 15. Stripe result
- **Code verified + fixed:** checkout `expires_at` clamp; env-var resolver tolerant of both `_MONTH/_YEAR` and `_MONTHLY/_YEARLY`; webhook signature + idempotency; plan transitions; revenue dashboards now read `status='paid'`. Pricing reconciled (see audit report §11). **Live: OPERATOR-REQUIRED** — confirm live keys + price IDs present, a Stripe test-mode checkout completes and the webhook updates `currentPlan`. **Do not create real charges**; if a live low-value transaction is needed to validate, that requires your explicit authorization (not done here).

## 16. SES / email result
- **Code verified:** centralized sender, provider precedence, suppression pre-check, SNS bounce/complaint webhook w/ signature verification, HTML-escaped templates, `email_fail` logging. **OPERATOR-REQUIRED (live):** SES out-of-sandbox + quota; SPF/DKIM/DMARC published; `APP_BASE_URL` (HTTPS) + `EMAIL_FROM` set in the PM2 env (else links fall back to localhost); a real confirmation email lands at Gmail **and** Outlook with the ICS. Missing by design (backlog): customer billing emails, email verification/welcome, staff invite.

## 17. Reminder result
- **Code verified:** correct selection/idempotency/timezone-in-staff-tz; reschedule re-arms; cancelled excluded. **OPERATOR-REQUIRED:** register the cron (§8) and confirm a reminder fires for a future test booking **without** sending to real customers (use a test booking only — task rule 13).

## 18. Super Admin result
- **Code verified + fixed:** all `/admin/*` gated by `SUPER_ADMIN_EMAILS` (404 to others); KPIs from real queries (no mock); tenant detail + Edit resolve (no 404); impersonation enter/exit; the revenue `$0` bug fixed (`succeeded`→`paid`). **OPERATOR-REQUIRED (live):** confirm counts against prod and that `ALLOW_DEV_SIMULATION` is off (so dev-seed rows don't inflate KPIs).

## 19. Tenant-isolation result
- **Code verified (strong):** broad trace of 202 API routes — zero client-supplied `tenantId`; every query session-scoped; cross-tenant ids → 404; staff/role narrowing; signed booking tokens; gated admin/impersonation. **No P0/P1 isolation defect.** Runtime cross-tenant negative tests are OPERATOR-REQUIRED (needs a multi-tenant live DB); the linchpin is a strong, unique production `JWT_SECRET` (confirm presence/entropy — value never printed).

## 20. Legal-page result
- **Created & wired:** `/privacy` + `/terms` (Google API Limited Use disclosure + account/data-deletion section + subprocessors + product-accurate billing terms), footer + login links fixed. Build/tsc pass.
- **OPERATOR-REQUIRED — exact values needed (I did not invent them; none exist in the repo):**
  1. `[LEGAL ENTITY NAME]` — the legal entity operating ZentroMeet
  2. `[REGISTERED ADDRESS]`
  3. `[GOVERNING JURISDICTION]` (Terms governing law)
  4. `[EFFECTIVE DATE]` / "Last updated" date
  5. Counsel review sign-off
  6. Confirm the `privacy@` and `support@zentromeet.com` inboxes are live (already referenced in code).
  (Candidate entity hint only, unverified: the workspace path references "AATS Inc" — **confirm with the owner; do not assume.**)

## 21. Monitoring result
- **OPERATOR-REQUIRED — cannot verify from repo.** Wire: an external uptime monitor on `/api/health` (alert on 503); alerts on `email_fail`/`smtp_health_fail` log lines; Stripe webhook-delivery dashboard alert; SES bounce/complaint alarms; cron-failure alerts (`cron_runs` where `status='failed'`); calendar `needs_reconnect` spike. Install OS logrotate for `/var/log/zentromeet/*`. Either install `@sentry/node` or remove the dead `SENTRY_DSN` claim.

## 22. Rollback procedure
**Pre-deploy capture:** `PREV=$(pm2 jlist | jq -r '.[0].pm2_env.GIT_COMMIT // "unknown"')` (or record the currently-deployed commit), and take the DB backup (§3).

**Deploy (operator, on host):**
```
cd /var/www/scheduling-saas
git fetch origin && git checkout launch-audit-fixes   # or merge to main first via PR
NODE_OPTIONS=--max-old-space-size=1024 npm ci && npm run build   # known-safe memory cap; no piping that can SIGPIPE the build
# apply ONLY new raw SQL migrations via the established psql loop (NOT drizzle-kit):
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done   # idempotent (IF NOT EXISTS) — review first
pm2 restart scheduling-saas --update-env && pm2 save
curl -fsS https://app.zentromeet.com/api/health | jq .ok
```

**Rollback (if health/smoke fails):**
```
cd /var/www/scheduling-saas
git checkout main && NODE_OPTIONS=--max-old-space-size=1024 npm ci && npm run build
pm2 restart scheduling-saas --update-env && pm2 save
# No schema rollback needed — this branch introduces NO migrations.
# If DB was changed out-of-band, restore the §3 dump: pg_restore --clean --no-owner -d "$DATABASE_URL" <dump>
```
Code rollback is clean: this branch adds no migrations and no schema changes; reverting to `main` fully reverts behavior. The previous release is also available via `git checkout main`.

## 23. Remaining risks
- **Production deploy + live smoke not yet performed** (no host access here) — the single largest residual: the decision cannot be GO until §10–§17 live checks pass on prod.
- **Legal pages have placeholders** until the owner supplies entity details + counsel review.
- **Microsoft publisher verification** unknown (blocker only if Outlook is promoted).
- **Open P1s (non-blocking, documented):** multi-tenant same-email login scoping; `tenant-patch-no-audit`; cron-heartbeat coverage; no customer billing emails.
- **Dependency CVEs:** 13 (11 moderate/2 high), all transitive/dev — schedule `npm audit fix` + major bumps; not in the request hot path.
- **In-memory rate limiter** under PM2 cluster — run single-instance or back with Redis.

## 24. Evidence (commands run here)
- `git` verify: branch `launch-audit-fixes` @ `a18a534`; `origin/launch-audit-fixes` == HEAD (`git rev-parse`); pushed (`* [new branch] launch-audit-fixes`).
- `npx tsc --noEmit` → **0 errors**.
- `npm test` → **722 pass / 0 fail / 203 suites** (713 prior + 9 new OAuth-state tests).
- `npm run build` → **PASS** (full route manifest emitted; sitemap/book now dynamic).
- Targeted: `tsx --test tests/calendar-oauth-state.test.ts` → **9/9 pass**.
- Secret/localhost/debug scan of `main..HEAD` diff → **clean** (only documentation prose matched).

## 25. Final launch decision
**WEB = CONDITIONAL GO** (code complete, validated, pushed; production deploy + live verification + legal-detail completion remain). **MOBILE = NO-GO** (no app exists).

---

## Final summary

```
WEB LAUNCH DECISION:        CONDITIONAL GO
DEPLOYED COMMIT:            a18a534 — validated + pushed to origin/launch-audit-fixes;
                            NOT yet merged to main or deployed to prod (operator host access required)
PRODUCTION HEALTH:          OPERATOR-REQUIRED — curl /api/health after deploy (code verified, endpoint robust)
DATABASE READY:             CONDITIONAL — schema/migrations correct; confirm 0066 applied + EXCLUDE constraint
                            on prod; apply via raw psql loop ONLY (never drizzle-kit push/migrate)
BACKUPS READY:              OPERATOR-REQUIRED — take + restore-test a dump before deploy (cannot verify from repo)
LEGAL READY:                CONDITIONAL — pages live in code; fill entity/address/jurisdiction/date + counsel review
GOOGLE READY:               CODE YES (CSRF nonce added, scopes aligned, tokens encrypted);
                            consent-screen verification + exact redirect URI = OPERATOR-REQUIRED
MICROSOFT READY:            CODE YES (CSRF nonce added, Graph complete); Azure publisher verification +
                            redirect URIs/scopes = OPERATOR-REQUIRED (blocker only if Outlook promoted)
STRIPE READY:               CODE YES (checkout 502 fixed, env tolerant, revenue fixed);
                            live keys/price IDs + test checkout = OPERATOR-REQUIRED
EMAIL READY:                CODE YES; SES out-of-sandbox + SPF/DKIM/DMARC + APP_BASE_URL = OPERATOR-REQUIRED
REMINDERS READY:            CODE YES; register cron + verify (test booking only) = OPERATOR-REQUIRED
CRON READY:                 CODE YES (scripts + manifest added); host registration = OPERATOR-REQUIRED
BOOKING FLOW READY:         CODE YES (engine verified, checkout fixed); live smoke = OPERATOR-REQUIRED
ONBOARDING READY:           YES (unbookable-service P0 + dead-end fixed; validated by build/tests)
SUPER ADMIN READY:          CODE YES (gated, honest KPIs, revenue $0 fixed); live count check = OPERATOR-REQUIRED
TENANT ISOLATION READY:     YES (strong; no P0/P1 found via full trace) — runtime negative tests recommended
MONITORING READY:           OPERATOR-REQUIRED — uptime/alerts/logrotate not verifiable from repo
ROLLBACK READY:             YES — no migrations/schema changes on this branch; clean revert to main (§22)
MOBILE STATUS:              NO-GO — no mobile app exists (empty stub); do not submit or advertise
BLOCKERS REMAINING:         0 code blockers. Remaining are operational/manual: production deploy + live smoke,
                            legal entity details + counsel review, prod env/cron/SES/Google confirmation.
SAFE TO ANNOUNCE PUBLIC LAUNCH: NOT YET — only after production deploy + the §22 live smoke test pass
                            and the legal pages are completed.
RECOMMENDED ACTION:         Open the PR (link in §1), merge to main, deploy on the host per §22, register the
                            cron manifest, complete legal details + Google verification, then run the live
                            smoke test. When §10–§17 pass on production, this flips to GO.
```

> No item above is marked "ready/pass" without code-level evidence, and every production-only step is labeled OPERATOR-REQUIRED rather than asserted. Mobile readiness is not claimed.

# ZentroMeet — Production Launch Readiness Audit

**Date:** 2026-06-14
**Auditor:** Automated evidence-based audit (17-subsystem deep review, 45 agents, adversarial verification of every P0/P1)
**Scope:** Full codebase, committed configuration, migrations, scripts, deploy docs, and local validation (typecheck, test suite, dependency audit). **Production runtime, live DB, live Stripe/SES/Google/Microsoft, and the EC2 host were NOT reachable from the audit environment** — items requiring those are listed explicitly under "Remaining manual actions" and per-section "cannot verify".

> Methodology note: findings were produced by reading the actual code and tracing logic end-to-end, not by assuming a feature works because code exists. Every P0/P1 was independently re-verified by a second adversarial pass. The local quality gate was run: `tsc --noEmit` (clean after fixes), `npm test` (713/713 pass after fixes), `npm audit`.

---

## 1. Executive summary

ZentroMeet is a **single Next.js 15 (App Router) multi-tenant scheduling SaaS** (`scheduling-saas`), serving marketing at `zentromeet.com` and the app at `app.zentromeet.com` from one process, backed by PostgreSQL (Drizzle ORM, 69 migrations) on AWS EC2 + PM2 + Nginx, with Stripe billing, AWS SES email, and Google/Microsoft calendar integrations.

**The engineering core is genuinely strong.** Tenant isolation is exceptionally disciplined (zero routes trust a client-supplied `tenantId`; every query is session-scoped). Auth uses bcrypt + jose HS256 with per-session jti revocation, HttpOnly/Secure/SameSite cookies, enumeration-resistant reset flows, and constant-time OAuth-state CSRF. The booking engine has a real Postgres `EXCLUDE` constraint backstop against double-booking, correct DST math, and an idempotent payment-hold lifecycle. Stripe webhooks verify signatures against the raw body with atomic idempotency. Calendar tokens are AES-256-GCM encrypted at rest. The `/api/health` endpoint runs 20+ real checks.

**But it is not launch-ready as-is.** The audit found **106 findings (3 P0, 16 P1, 46 P2, 40 P3; 1 refuted)**, including **7 launch blockers**. The most serious were: no Privacy/Terms pages despite signup forcing agreement to them (and these are required for Google OAuth verification); a paid-booking checkout bug that 502s on the default config; an env-var name mismatch that can disable all paid checkout; calendar push-channel renewal never scheduled (calendar sync silently dies after channels expire); a "14-day free trial, no credit card" claim that is false (checkout bills immediately); an onboarding flow that marks a workspace "live & ready" while producing an **unbookable** booking page; and **no mobile app exists at all** (the `zentromeet-mobile/` folder is an empty stub).

**This audit fixed every code-level blocker and serious P1 that could be safely fixed surgically** (13 fix areas across 28 files), validated by a green typecheck and test suite. The remaining blockers are **operational/manual** (legal-entity details + counsel review, Google/Microsoft verification, production env + cron + SES confirmation) and **the entirely-missing mobile app**.

## 2. Current launch recommendation

> ### WEB platform: **CONDITIONAL GO**
> Conditional on completing the enumerated "Remaining manual actions" (§28) and the "Launch-day checklist" (§29) — principally: fill the legal pages' entity details + counsel review, confirm production Stripe price env vars, register the full cron set on the host, confirm SES is out of sandbox, and confirm Google OAuth (and, if Outlook is promoted, Microsoft) verification status.
>
> ### MOBILE (Android + iOS): **NO-GO**
> No mobile application exists. Only backend endpoints + a push pipeline are present. Do not announce, submit, or list a mobile app. (See §18/§19.)

Rationale: all code-level launch blockers are fixed and validated, but several blockers are inherently operational and unverifiable from the repo, and the mobile deliverable is at 0%. A responsible public launch of the **web** product is achievable quickly once the manual checklist is cleared; mobile is a separate, future project.

## 3. Exact launch blockers

| # | Blocker | Sev | Status |
|---|---|---|---|
| B1 | Privacy Policy & Terms pages did not exist, yet signup forces agreement + Google verification requires them | P0 | **Fixed in code** (pages created, footer/login wired) — *needs entity details + counsel review + deploy* |
| B2 | Onboarding completes & shows "live & ready to take bookings" but the service has no staff → public booking page empty/404 | P0 | **Fixed** |
| B3 | No mobile app exists (empty stub) | P0 | **Cannot fix** — out of scope; mobile = NO-GO |
| B4 | Paid-booking Stripe Checkout `expires_at` < Stripe's 30-min floor → booking 502s on default config | P1🚫 | **Fixed** |
| B5 | Stripe price env-var name mismatch (`_MONTHLY/_YEARLY` docs vs `_MONTH/_YEAR` code) → can disable all paid checkout | P1🚫 | **Fixed** (resolver tolerant + docs corrected) — *confirm prod env* |
| B6 | `calendar-webhook-renew` has no npm script / cron → Google/MS push channels expire unrenewed → calendar sync silently dies | P1🚫 | **Fixed in code** (script + manifest) — *register cron on host* |
| B7 | "14-day free trial · no credit card required" advertised everywhere but checkout bills immediately | P1🚫 | **Fixed** (copy corrected to match reality) |

🚫 = verifier confirmed `isLaunchBlocker=true`.

## 4. P0 issues

1. **`missing-privacy-terms-pages`** (B1) — `app/dashboard/login/page.tsx:375-387` forces "By signing in you agree to our Terms and Privacy Policy" linking to `zentromeet.com/{terms,privacy}`, which had **no route** (apex serves this same Next app per `app/page.tsx:11-24`). Also breaks Google OAuth verification (requires a published privacy policy with data-deletion) and Stripe/GDPR obligations. **Fixed:** created `app/privacy/page.tsx` + `app/terms/page.tsx` (with the required Google API Limited Use disclosure and an account/data-deletion section), wired `components/Footer.tsx`, fixed the dangling `/security` link.
2. **`onboarding-completes-with-unbookable-service`** (B2) — `lib/onboarding/integrity.ts` checked only `has_services` + `has_availability`, never `serviceStaff`. Both onboarding paths created services with **zero** staff, but every public booking surface inner-joins `serviceStaff` (`app/u/[slug]/page.tsx:101-108`, funnel `notFound()` at `[serviceSlug]/page.tsx:80`, `app/api/slots/route.ts:88`). The single-admin solo tenant — the most common case — got a booking page nobody could use. **Fixed.**
3. **`no-mobile-app-exists`** (B3) — see §18/§19. Not fixable here.

## 5. P1 issues

Launch-blocking P1s (B4–B7) are in §3. Remaining confirmed P1s:

| ID | Issue | Status |
|---|---|---|
| `billing-status-paid-vs-succeeded` | Webhook writes `billing_transactions.status='paid'` but 23 admin-analytics queries filter `='succeeded'` → super-admin revenue/finance dashboards read **$0 on real data** and the billing validator false-flags every paying tenant | **Fixed** (23 admin-analytics filters + 2 seeder literals → `paid`) |
| `login-unscoped-email-multitenant` | `app/api/auth/login/route.ts:39-41` resolves users by globally-unscoped email; email is unique only per `(tenant_id, email)` → same email in 2 workspaces logs into an arbitrary tenant / can't reach the 2nd account / reset targets wrong account. `loginSchema` has no `tenantSlug` field | **Open — documented** (needs `tenantSlug` added to schema + scoped lookup; low incidence at launch) |
| `status-route-cancelled-bypasses-cancel-pipeline` | `POST /api/bookings/[id]/status` accepted `cancelled`, skipping the cancel feature-gate, customer email, calendar-event deletion, and waitlist release | **Fixed** (route rejects `cancelled`) |
| `calendar-oauth-csrf-no-nonce` | Calendar connect used predictable `state=user.id` with no cookie-bound nonce (calendar-injection) | **Fixed** (single-use httpOnly constant-time nonce on Google new+legacy and Microsoft connect/callback; `lib/calendar/oauth-state.ts` + 9 tests) |
| `no-azure-setup-docs-or-verification-evidence` | No Azure app-registration / redirect-URI / scope / publisher-verification documentation or evidence | **Open — manual** (§10) |
| `no-customer-billing-emails` | No customer-facing upgrade/downgrade/cancellation/payment-failure/trial-ending emails (admin-side alerts exist) | **Open — backlog** (product decision) |
| `health-cannot-detect-missing-reminder-cron` | Health `reminder_delivery` reports healthy when the cron was never installed (0 sent + 0 failed) | **Partially mitigated** by cron-manifest; deeper fix backlog |
| `tenant-patch-no-audit` | `PATCH /api/admin/tenants/[id]` (suspend/plan-override/extend-trial) writes no audit log though the UI implies all actions are audited | **Open — documented** (small fix; align with the other two admin action routes) |
| `seeded-data-in-production-kpis` | Dev-simulation seeds real rows into prod tables that no admin KPI/finance query excludes | **Open — manual+backlog** (gate `ALLOW_DEV_SIMULATION=false` in prod + add `is_demo` exclusion) |
| `drizzle-journal-frozen-at-0000` | Drizzle journal/snapshot frozen at `0000`; `db:migrate`/`generate`/`push` are out of sync with the real schema (migrations are applied via a raw `psql` loop) | **Open — HAZARD documented** (§16; do NOT run `drizzle-kit push/migrate` against prod) |
| `cron-heartbeat-only-2-of-14-jobs` | `/admin/ops` cron heartbeat instruments only 2 of ~14 jobs; the rest render permanent false "down" | **Open — backlog** |
| `done-step-deadend-empty-availability` | All-days-off saved empty availability → terminal "done" step with no Back/Finish-later → completion permanently blocked | **Fixed** (guard + always-available "Finish later" + Back on done) |

## 6. P2 issues (46 — highlights; full list in appendix §32)

Fixed in this pass: `comms-key-gen-hint-base64-vs-hex` (`.env.example` corrected to `openssl rand -hex 32`); the trial-claim P2 copies (`free-faq-trial-text`); stale Stripe-price-var docs in LAUNCH.md; `empty-footer-no-legal-nav` (footer wired); the masked `tsc` error in `OverviewMissionHero.tsx` (React 19 `JSX`→`React.JSX`); `tests/plans.test.ts` stale assertions.

Notable open P2s (documented, recommended pre/post-launch): `no-app-wide-csp` (only `/embed` sets a CSP — adding a strict app-wide CSP needs nonces; risky to add blind); `outbound-webhook-ssrf` (tenant notification webhook raw `fetch` with no SSRF guard, unlike the calendar-feed fetcher which IS defended); `pending-hold-not-overlap-protected` (paid pending hold can be bumped by a confirmed/free booking mid-checkout — confirmed-only EXCLUDE constraint means no *persisted* double-book); `no-email-verification-or-welcome`; `localhost-fallback-in-email-links` (emails fall back to `http://localhost:3001` if `APP_BASE_URL` unset); `health-endpoint-unauthenticated-info-disclosure`; `sentry-dsn-advertised-no-dependency` (`@sentry/node` not installed); `no-log-rotation-for-cron-logs`; `uploads-local-disk-spof`; `mobile-oauth-token-in-url`.

## 7. P3 / post-launch improvements (40 — see appendix §32)

Includes: booking action tokens replayable for 30 days (no single-use); Google/MS disconnect leaves webhook channels orphaned; `calendar.readonly` never used to fetch/select calendars (always `primary`); HSTS without `includeSubDomains/preload`; rate-limit key from spoofable XFF first-hop; avatar upload trusts client MIME; OAuth callbacks log full token object on failure; `cron_runs` has no retention pruner; legacy plaintext token backfill (0019) never scrubbed; `db/seed.sql` creates a known-password tenant if run against prod; public pricing page shows monthly-only.

## 8. Critical workflow test matrix

Legend: ✅ verified by code-trace (evidence) · 🔧 fixed this pass · ⚠️ works but caveat · ⛔ broken/missing · ❓ needs production to confirm.

| # | Workflow | Result | Evidence / note |
|---|---|---|---|
| 1 | Signup (tenant) | ✅ | bcrypt cost 10, per-tenant email unique, session issued; ⚠️ no email verification/welcome |
| 2 | Login | ✅ / ⚠️ | works; multi-tenant same-email edge case (P1, open) |
| 3 | Onboarding | 🔧 | unbookable-service P0 + done-step dead-end both fixed |
| 4 | Calendar connect (Google) | ✅ / ❓ | OAuth + encrypted tokens + scope alignment correct; redirect URI exactness needs prod |
| 5 | Appointment-type creation | ✅ / 🔧 | CRUD + plan caps work; now auto-links creator as staff |
| 6 | Public booking | ✅ | DST math, buffers, min-notice/horizon, conflict union all correct |
| 7 | Calendar event creation | ✅ / ❓ | create/update/cancel, only-customer attendee, Meet gating; live provider needs prod |
| 8 | Confirmation email + ICS | ✅ / ❓ | wired via triggerAutomation + ICS; live SES delivery needs prod |
| 9 | Reminder selection | ✅ | correct status/isNull filters; idempotent; ⚠️ renders in staff TZ |
| 10 | Reschedule | ✅ | re-validates slot in txn, clears reminder flags, provider-locked sync |
| 11 | Cancellation | 🔧 | dedicated cancel route correct; status-route bypass closed |
| 12 | Stripe free plan | ✅ | free signup/booking never blocked by Stripe |
| 13 | Stripe paid plan | 🔧 / ❓ | checkout `expires_at` 502 fixed; env-var mismatch made tolerant; live test needs prod keys |
| 14 | Upgrade/downgrade | ✅ / ❓ | plan transitions observed/audited; proration/portal need live Stripe |
| 15 | Tenant isolation | ✅ | broad sweep: zero client-supplied tenantId; every query session-scoped |
| 16 | Super Admin tenant view | ✅ / 🔧 | gated + honest KPIs; revenue `$0` bug fixed |
| 17 | Mobile production build | ⛔ | no app exists |
| 18 | Production health check | ✅ / ❓ | endpoint robust; live status needs prod |

## 9. Google integration status

**Code: strong and correct.**
- Scopes are minimal and aligned (commit `00218b0`): runtime `openid + email + calendar.readonly + calendar.events` is a strict subset of the consent-screen list (`lib/calendar/google.ts:47-52`). ✅
- Refresh tokens AES-256-GCM encrypted at rest; `prompt=consent` + `access_type=offline` guarantee a refresh token; revoked/expired → `needs_reconnect` with dedup email. ✅
- Freebusy keying bug already fixed (unions across calendars); pre-commit conflict revalidation present. ✅
- Sign-in OAuth (separate from calendar) uses correct cookie-bound CSRF state. ✅

**Gaps:**
- **`calendar-oauth-csrf-no-nonce` (P1) — FIXED (stabilization phase):** the *calendar-connect* flow now mints a single-use, httpOnly, constant-time, per-provider-namespaced state nonce (`lib/calendar/oauth-state.ts`, cookie `zm_cal_state_*`) on Google (new + legacy) and Microsoft connect/callback. User/tenant association is unchanged (still from the verified session). 9 unit tests added. **Still recommended:** run the live connect round-trip per provider before/at deploy (cannot be exercised against live Google/Microsoft from the audit environment).
- `disconnect-leaks-google-watch-channel` (P3), `no-calendar-list-or-additional-calendar-selection` (P3 — always `primary`; `calendar.readonly` scope unused).
- **Cannot verify (manual):** consent-screen "In production"/verified status; exact `GOOGLE_REDIRECT_URI` match in Google Console; `APP_BASE_URL` is HTTPS (watch addresses); `COMMS_ENCRYPTION_KEY` is 64-hex in prod.

**Verification requirement:** the new `/privacy` page (with the Limited Use disclosure) must be live and the entity details filled before submitting for Google verification. With the sensitive `calendar.events` scope, an unverified app shows a warning and is capped (~100 users) — verification is required for public launch.

## 10. Microsoft Outlook integration status

**Code: functionally complete and high-quality, at parity with Google** (sign-in, calendar connect/callback, Graph adapter, webhooks with `validationToken` handshake + `clientState` check, rolling-refresh handling, only-customer attendee, Teams URL preserved across reschedule). The Outlook connect button is actually wired (`StaffClient.tsx:4396`). Migration `0045` is additive/safe.

**The launch risk is operational, not code (P1 `no-azure-setup-docs-or-verification-evidence`):**
- No Azure app-registration runbook exists in the repo. Cannot verify from code: app registration exists/multi-tenant; **both** redirect URIs registered (`/api/auth/oauth/microsoft/callback` **and** `/api/calendar/microsoft/callback`) against prod `APP_BASE_URL`; delegated scopes pre-registered (`Calendars.ReadWrite`, `OnlineMeetings.ReadWrite`, `User.Read`, `offline_access`); **publisher verification status** (consent screen "verified" vs "unverified").
- Shares the calendar-connect CSRF-nonce gap (§9) and `disconnect-orphans-graph-subscription` (P3).

**Recommendation:** the pricing FAQ currently says Outlook is "on the roadmap" (honest/conservative). **If you do not promote Outlook at launch, Microsoft verification is not a launch blocker.** If you do promote it, complete Azure publisher verification + redirect-URI/scope registration first and produce the runbook.

## 11. Stripe & pricing reconciliation

**Mechanics:** webhook signature on raw body (`runtime=nodejs`), atomic idempotency (`processed_stripe_events` ON CONFLICT + partial unique indexes on `billing_transactions`), plan transitions audited, reverse price→plan lookup never clobbers on unknown prices, free flows never blocked by Stripe. ✅

**Two authoritative plan sources agree** after migration `0066`: the TS catalog `lib/plans.ts` (drives pricing page, enforcement, checkout, upsells) and the DB `plans` table (drives `/admin/plans` + MRR). Prices match.

**Pricing reconciliation table** (USD; ∞ = unlimited; "—" = not offered):

| Source | Plan | Monthly | Annual | Key limits (staff / mgr / bookings / active services) |
|---|---|---|---|---|
| `lib/plans.ts` (drives pricing page + enforcement + checkout) | Free | $0 | — | 1 / 0 / ∞ / 3 |
| | Solo | $10 | $110 | 1 / 0 / ∞ / ∞ (branding+analytics) |
| | Pro | $30 | $330 | 3 / 1 / ∞ / ∞ |
| | Team | $100 | $1,100 | 10 / 1 / ∞ / ∞ |
| | Enterprise | $250 | $2,750 | ∞ / ∞ / ∞ / ∞ (SSO) |
| DB `plans` (migration 0066 — `/admin/plans` + MRR) | Free…Enterprise | **matches** | **matches** | matches |
| DB migration 0065 (**SUPERSEDED** by 0066) | — | Pro **$10**, a since-deactivated **"business"** tier, Free bookings **50** | | stale values — verify 0066 applied in prod |
| `.env.example` (Stripe var **names**) | Solo/Pro/Team/Ent | `STRIPE_PRICE_*_MONTH` | `STRIPE_PRICE_*_YEAR` | **was `_MONTHLY/_YEARLY` — FIXED to match code** |
| `lib/stripe.ts` (names code reads) | Solo/Pro/Team/Ent | `STRIPE_PRICE_*_MONTH` | `STRIPE_PRICE_*_YEAR` | + legacy `STRIPE_PRICE_PRO/TEAM` fallback |
| LAUNCH.md / PRODUCTION_DEPLOY.md | (was Pro/Team only) | stale | — | **LAUNCH.md FIXED; PRODUCTION_DEPLOY.md still stale (P2)** |

**Discrepancies & status:** env-var name mismatch (B5) — **fixed** (resolver now reads both suffixes; `.env.example` + LAUNCH.md corrected). 14-day-trial claim (B7) — **fixed** (copy corrected; checkout has no `trial_period_days` since Phase 16E). DB 0065 superseded values — confirm 0066 applied in prod. `PRODUCTION_DEPLOY.md` Stripe vars still stale (P2, low risk).

**Cannot verify:** whether prod `.env` populated the price IDs (now tolerant either way); whether 0066 is applied in prod; whether any Stripe Price has a dashboard-level trial.

## 12. Email & SES status

**Code:** single centralized sender (`lib/email.ts`) with provider precedence Resend→Postmark→SMTP/SES→stub; pre-send suppression check on every send; SES SNS bounce/complaint webhook with TopicArn allowlist + signature verification + host pinning; secret-scrubbing + dedup/cooldown on admin alerts; HTML-escaped templates; structured `email_fail` logging (domain only, no PII). ✅

**Coverage:** booking confirmation/reschedule/cancel/reminder ✅; password reset ✅ (caveats below); new-tenant admin notice ✅; calendar-reconnect alert ✅. **Missing:** email verification, welcome email, staff invite, **all customer-facing billing emails** (upgrade/downgrade/cancellation/payment-failure/trial-ending — admin-side only). Dead admin alert kinds `plan_upgrade/plan_downgrade/trial_expired` declared but never dispatched.

**Caveats (P2/P3, open):** `localhost-fallback-in-email-links` (falls back to `http://localhost:3001` if `APP_BASE_URL` unset — set it in the PM2 process env); no `Reply-To` though templates invite replies; cancel/reschedule emails bypass the `communication_logs` idempotency layer; customer emails render time in **staff** timezone labeled as the customer's; template `escape()` omits single-quote (low risk).

**Cannot verify (manual — §28):** SPF/DKIM/DMARC DNS; SES **out-of-sandbox** + quota; SNS bounce/complaint subscription confirmed; `email_suppressions` table exists in prod (journal frozen at 0000 — apply via the raw psql loop); inbox placement.

## 13. Reminder & scheduler status

**Code is well-built** (per-row try/catch, idempotency via `communication_logs` partial-unique + booking flags, atomic claim for automations, soft-lock for feeds, reschedule re-arms reminders, plan-aware cron guards). ✅

**The launch problem was registration, not logic (B6 + `only-reminders-cron-registered`).** The repo ships ~17 scheduled jobs but the runbooks registered exactly **one** (`reminders:send`). Critically, `calendar-webhook-renew` had **no npm script and no registration** → Google/MS push channels (TTL ~7h–70h) expire → calendar sync silently stops → stale conflict data → double-booking risk.

**Fixed:** added npm scripts (`calendar:webhook-renew`, `calendar:drift`, `freebusy:cleanup`, `payments:reconcile`, `domains:ssl`) and authored **`docs/operations/cron-manifest.md`** — the complete crontab with cadences and an impact table. **Manual action:** register the manifest on the host and verify via `/api/health` + `cron_runs`.

**Open:** `cron-heartbeat-only-2-of-14-jobs` (P1, monitoring blindness — most jobs render false "down"); `no-overlap-guard-on-crons` (P3); `feature-disabled-reminder-permanent-suppression` (P2).

## 14. Security findings

**Strong primitives (verified):** AES-256-GCM authenticated encryption for credentials at rest; Stripe webhook signature + atomic replay protection; OAuth login CSRF (cookie nonce + `timingSafeEqual`); open-redirect guard on post-login `next`; OAuth requires verified email; 32-byte one-time bcrypt-hashed reset tokens; purpose-scoped booking JWTs; HTML-escaped email templates; **SSRF-defended fetcher for calendar-feed URLs** (scheme allowlist, userinfo reject, DNS private/IMDS block); no production source maps; per-IP login rate limit + generic error; global security header baseline (nosniff, XFO SAMEORIGIN, Referrer-Policy, HSTS, Permissions-Policy, COOP).

**Gaps:** calendar-connect CSRF nonce (P1, §9); **no app-wide CSP** (P2 — only `/embed` sets `frame-ancestors`); outbound tenant-webhook SSRF (P2 — the notification webhook does a raw `fetch`, unlike the feed fetcher); `safeFetch` DNS-rebinding TOCTOU (P2); in-memory rate-limit/jti-cache under PM2 cluster (P2 — but PRODUCTION_DEPLOY.md documents single-instance, so impact depends on actual topology); avatar upload trusts client MIME (P3); OAuth callbacks log full token object on failure (P3); HSTS no `includeSubDomains/preload` (P3, documented tradeoff); XFF-spoofable rate-limit key (P3 — depends on nginx overwriting XFF).

**Cannot verify (manual):** TLS config/ciphers; nginx XFF overwrite; real PM2 topology; production secret entropy (`JWT_SECRET`, `COMMS_ENCRYPTION_KEY`, `STRIPE_WEBHOOK_SECRET`); HSTS preload status.

**Dependencies (`npm audit`): 13 vulnerabilities (11 moderate, 2 high)** — all transitive/dev-chain: `esbuild`/`@esbuild-kit/*` via `drizzle-kit` (dev), `uuid` via `googleapis`/`node-ical`/`gaxios`, `postcss` (via Next bundle), `qs`. None are direct runtime RCE in the request path. `qs` has a clean non-breaking fix; the rest require major bumps (`drizzle-kit`, `googleapis`, `node-ical`) — schedule, don't block launch. Run `npm audit fix` for the safe ones; track the breaking ones in the backlog.

## 15. Tenant-isolation findings

**No P0/P1 isolation defect found** via a broad source trace of 202 API routes + auth/impersonation/token/client-auth primitives. `tenantId` is **always** server-derived (verified JWT, server-side resource lookup, or signed-token claim) — grep for `body.tenantId`/`params.tenantId` returned **zero**. Per-id routes AND `tenantId` on both read and write; cross-tenant ids return **404** (no existence disclosure); staff vs managerial role narrowing enforced; super-admin routes throw 404 to non-admins; impersonation is gated + reversible; booking action tokens are purpose-scoped and tenant/booking-bound; the client portal is tenant+customer+booking-email scoped; exports are role-narrowed + audited.

Only nits: `tasks-related-booking-id-not-tenant-validated` (P3 — `assignedUserId`/`relatedCustomerId` ARE validated); booking action tokens replayable 30 days (P3); `exit-impersonation-restores-invalid-original-cookie` (P3).

**Cannot verify (manual):** runtime cross-tenant exploitation (needs running app + multi-tenant DB); whether DB-level RLS exists as a backstop (isolation is enforced entirely in app query builders — **the linchpin is a strong, unique production `JWT_SECRET`**); effective `SUPER_ADMIN_EMAILS` contents.

## 16. Database findings

`db/schema.ts` (2,709 lines, 64 tables, 2 enums); 69 raw SQL migrations `0000–0070` (**`0046` & `0049` intentionally absent** — verified no references; the `for f in db/migrations/*.sql` deploy loop applies all present files). Double-booking `EXCLUDE` constraint present + health-checked; enums evolved correctly via `ADD VALUE IF NOT EXISTS`; `tenant_id NOT NULL` + index on every tenant-owned table; calendar tokens + payment credentials + feed URLs encrypted; FK cascade behavior deliberate (bookings `RESTRICT`, children `CASCADE`); `is_demo` quarantine wired (`0070`).

**⚠️ HAZARD (P1 `drizzle-journal-frozen-at-0000`):** `db/migrations/meta/_journal.json` lists only `0000`. **Migrations are applied via a raw `psql` loop, NOT `drizzle-kit`.** Running `npm run db:migrate`/`db:push`/`db:generate` against production would diff against a 1-table snapshot and could **drop/alter** live tables. **Do not run drizzle-kit migration commands against prod.** (Documented; regenerating the journal safely is a backlog task.)

Other: `overlap-constraint-not-in-schema` (P2 — exists only in raw SQL, not `schema.ts`); `is-demo-not-filtered-in-admin-rollups` (P2); legacy plaintext token backfill never scrubbed (P3); `db/seed.sql` creates a known-`bcrypt('demo1234')` tenant if run against prod (P3).

## 17. Infrastructure findings

`/api/health` is genuinely deep (20+ DB-backed checks, per-check latency, correct hard-fail [DB, EXCLUDE constraint, governance, Cloudflare-if-configured] vs soft-fail [SMTP/Stripe/calendar — booking engine stays up]). Migration loop applies the full tree. Certbot SSL auto-renew + HTTP→HTTPS documented. Structured JSON logger. Broad operational runbooks (db-failover, rollback, ses/stripe/oauth outages, queue/worker failures).

**Doc-vs-code gaps:** `MAINTENANCE_MODE` documented but **no code reads it** (P2); `SENTRY_DSN` advertised but `@sentry/node` not installed (P2); cron heartbeat covers 2/14 jobs (P1); stale migration counts in docs (P2 — LAUNCH.md fixed); no `cron_runs` pruner (P3); PM2 cluster sample vs in-process state (P2). `uploads-local-disk-spof` (P2 — avatars/logos only on EC2 disk, no object storage). No `next.config.ts` change to `ignoreBuildErrors`/`ignoreDuringBuilds` (intentional for the memory-constrained box; local `tsc` gate is now green — keep the local gate, don't flip the flag and risk build OOM).

**Cannot verify (manual — §28):** PM2 startup persistence/topology/memory; SSL renew timer active; deployed nginx config; backups exist + restore; RAM headroom/OOM history; OS log rotation; disk usage; external uptime/alerting.

## 18. Mobile — Android status: ⛔ NOT READY

**No Android project exists.** Quantified: no React Native/Expo dependency; no Gradle/`AndroidManifest.xml`; no package name/`versionCode`/`versionName`; no keystore/signing; no Codemagic/EAS/`app.json`; no permissions/privacy disclosures; no store assets; no account-deletion flow. `zentromeet-mobile/` is an empty, untracked `app/appointments` dir; `app/api/mobile/telemetry/route.ts` even references a non-existent `zentromeet-mobile/src/lib/telemetry.ts`. What exists (backend only): tenant+role-scoped `GET /api/bookings/[id]`, a real `zentromeet://` OAuth deep-link flow, real push-token registration + Expo push-delivery worker, an auth-optional telemetry sink. **Mobile readiness ≈ 0% (app + build/sign/submit pipeline). Do not submit to Play Store.**

## 19. Mobile — iOS status: ⛔ NOT READY

Same as §18: no iOS project, bundle id, `Info.plist`, build number, signing/provisioning, EAS/Codemagic, App Store privacy labels, or account-deletion. **Do not submit to TestFlight/App Store.** Marketing does **not** currently claim a native app (verified) — keep it that way until an app exists.

## 20. Legal / compliance status

**Was a P0 blocker; now fixed in code, pending completion.** Created `/privacy` and `/terms` with: Google API Limited Use disclosure (required for Google verification), account/data-deletion section (required for Google + GDPR/CCPA), subprocessor list (AWS/Stripe/Google/Microsoft/Cloudflare), retention, customer-as-controller wording, and product-accurate billing terms (immediate billing, downgrade at period end, no auto-trial — matching code). Footer now links Privacy/Terms/Support; login `/security` dangling link fixed.

**Must complete before launch (counsel + business):** fill `[LEGAL ENTITY NAME]`, `[REGISTERED ADDRESS]`, `[GOVERNING JURISDICTION]`, `[EFFECTIVE DATE]`; have counsel review; confirm `privacy@` / `support@zentromeet.com` inboxes exist. Marketing claims now match implementation (trial copy corrected; Google Meet/round-robin/embed claims are backed by code; no mobile/SMS/AI over-claims).

## 21. Exact files changed

**New (3):** `app/privacy/page.tsx`, `app/terms/page.tsx`, `docs/operations/cron-manifest.md`, plus this report.

**Modified (25):** `.env.example`, `LAUNCH.md`, `app/api/bookings/route.ts`, `app/api/bookings/[id]/status/route.ts`, `app/api/onboarding/apply-template/route.ts`, `app/api/services/route.ts`, `app/dashboard/login/page.tsx`, `app/for/[vertical]/page.tsx`, `app/page.tsx`, `app/pricing/page.tsx`, `components/Footer.tsx`, `components/OnboardingWizard.tsx`, `components/admin/OverviewMissionHero.tsx`, `lib/onboarding/integrity.ts`, `lib/stripe.ts`, `package.json`, `tests/plans.test.ts`, `lib/dev-seeding/seeder.ts`, and 7 `lib/admin-analytics/*` files (`billingValidator`, `finance-intelligence`, `finance`, `plans-intelligence`, `revenue-intelligence`, `revenue`, `snapshots`).

Diffstat: **25 modified files, +220/−87**, plus 3 new files. No changes to auth architecture, deployment architecture, DB schema/migrations, or pricing/plan values.

### Fix-by-fix (root cause → change)

1. **Checkout 502 (B4)** — `app/api/bookings/route.ts`: clamp Stripe `expires_at` to `max(holdExpiry, now+31min)` so it never falls below Stripe's 30-min floor.
2. **Cancel bypass (P1)** — `app/api/bookings/[id]/status/route.ts`: reject `status:"cancelled"` with 400 directing to the cancel endpoint.
3. **Unbookable onboarding (B2)** — `app/api/services/route.ts` (default-link creator when no staff), `app/api/onboarding/apply-template/route.ts` (insert `serviceStaff` for admin), `lib/onboarding/integrity.ts` (add `no_staff` activation blocker + copy).
4. **Onboarding dead-end (P1)** — `components/OnboardingWizard.tsx`: guard all-days-off in `saveHours`, always render "Finish later" (+ Back) on the done step.
5. **Stripe env mismatch (B5)** — `lib/stripe.ts`: `readEnvPrice()` reads both `_MONTH/_YEAR` and `_MONTHLY/_YEARLY`; `.env.example` + LAUNCH.md corrected.
6. **Encryption-key hint (P2)** — `.env.example`: `openssl rand -hex 32` (64 hex), matching `lib/crypto.ts`.
7. **Trial false-claim (B7)** — `app/page.tsx`, `app/for/[vertical]/page.tsx`, `app/pricing/page.tsx` (×3), `components/OnboardingWizard.tsx`: copy corrected to immediate-billing reality.
8. **Revenue `$0` (P1)** — 7 `lib/admin-analytics/*` files + `lib/dev-seeding/seeder.ts`: `status='succeeded'` → `'paid'` (23 + 2). Event-taxonomy `"succeeded"` constant correctly untouched.
9. **Legal (B1/P0)** — `app/privacy/page.tsx`, `app/terms/page.tsx`, `components/Footer.tsx`, `app/dashboard/login/page.tsx`.
10. **Crons (B6)** — `package.json` (5 scripts), `docs/operations/cron-manifest.md`, LAUNCH.md pointer.
11. **Stale tests (P2)** — `tests/plans.test.ts` updated to the 5-tier model.
12. **Masked type error (P2)** — `components/admin/OverviewMissionHero.tsx`: `JSX`→`React.JSX`.
13. **Stale docs (P2)** — LAUNCH.md migration range + Stripe var table + cron note.

## 22. Tests added or updated

- `tests/plans.test.ts` — rewritten to the current 5-tier catalog (Solo added, Enterprise `$250/mo` self-serve, Team 10 staff, Free unlimited bookings). Re-establishes guardrails that had silently rotted. Suite is **green**.
- No other test files changed. (Recommended backlog: add a regression test that onboarding-created services have ≥1 `serviceStaff`; a test that `priceIdFor` resolves both env suffixes; a route test that `status:"cancelled"` is rejected.)

## 23. Commands run

- `npx tsc --noEmit` → **0 errors** (was 2, in `OverviewMissionHero.tsx`).
- `npm test` → **713 pass / 0 fail / 202 suites** (was 709/4-fail in `plans.test.ts`).
- `npm audit` → 13 vulns (11 moderate, 2 high), all transitive/dev (see §14).
- `git status` / `git diff --stat` for the change inventory.
- Read-only: ripgrep/grep sweeps, migration + schema inspection. **No** build, dev server, package-script execution, migrations, network calls, or emails were run (per audit constraints).

## 24. Build results

`next build` was **not** run (memory-intensive on the constrained box and not required to validate these changes; the project intentionally sets `typescript.ignoreBuildErrors`/`eslint.ignoreDuringBuilds` for deploy performance). Validation was done via the local `tsc --noEmit` gate (clean) and the test suite (green) — which is the project's documented pre-commit gate. **Run `next build` on the deploy host / CI before deploying** as a final check.

## 25. Deployment status

**DEPLOYED to production (2026-06-15).** Commit **`7cd1118`** was deployed to `ubuntu@35.83.95.42:/var/www/scheduling-saas` (PM2 `scheduling-saas`, fork) via `git pull --ff-only → npm run build → pm2 restart` after a validated DB backup. Production is **live + healthy** (`/api/health` 200 `ok:true`; pm2 online, 0 unstable restarts), `/privacy` + `/terms` now resolve (200) with the Google Limited-Use disclosure, `/book` dynamic fix live, and `calendar:webhook-renew` cron registered + verified (renewed 1/1). Rollback ready (`fc5df06` + `.next.rollback`). Remaining to GO: live transactional smoke (signup→booking→email, Google/MS connect, Stripe checkout) + the ParaFort LLC mailing address. **Full deployment evidence: `ZENTROMEET_FINAL_LAUNCH_VALIDATION.md` → Stabilization Phase 3.** Prior status below (historical):

**Merged to `main`, NOT deployed to the host.** Update (stabilization phase 2): the web fixes were merged into `main` (`origin/main` = `bc20589`, fast-forward, no force) and validated **on the merged tree** (`tsc` 0 errors, `npm test` 722/722, **`next build` passes**). Note `main` also gained a separate React Native/Expo mobile app under `mobile/` (added after the audit); it was not worked on, and the web typecheck now excludes it. The validated artifact is ready on `origin/main`; the **in-place production deploy was not executed** because it could not be done safely from the audit machine (no documented in-place update process; prod host/key/user/path/pm2-service not identifiable without guessing; live system is healthy; live Google/Microsoft/Stripe/SES smoke needs test accounts). Production was confirmed **live + healthy** via read-only probe (`app.zentromeet.com/api/health` → 200, `ok:true`). Deploy runbook + reasons + revised GO/NO-GO are in `ZENTROMEET_FINAL_LAUNCH_VALIDATION.md` (Stabilization Phase 2 section).

## 26. Rollback plan

- **Code:** changes are isolated on `launch-audit-fixes`; revert by checking out `main` (or `git revert <commit>`). No schema/migration changes, so no DB rollback needed. Previous release remains deployable.
- **Per-fix safety:** all fixes are additive/guarding (clamps, guards, default-links, copy, tolerant env reads, new pages, doc/test updates). The billing-status replace is a literal swap restoring already-broken dashboards. None alter money movement, auth, schema, or pricing values.
- **If a fix misbehaves in prod:** the highest-touch change is the 23-site `succeeded`→`paid` swap (read-only analytics) and the onboarding staff auto-link (additive insert) — both safe to revert independently.
- **Standard infra rollback** is documented in `docs/operations/deployment-rollback.md` (capture state → PM2 restart previous release).

## 27. Production cleanup proposal (NOT executed — confirm counts against prod first)

1. **Demo/seed quarantine:** `SELECT id,slug,name FROM tenants WHERE is_demo=true;` → either `npm run docs-demo:reset` or add `AND is_demo=false` to admin-analytics aggregates. (`scripts/prelaunch-cleanup.sql` already removes all non-super-admin tenants.)
2. **Dev fixtures (only if promoting a dev DB):** `SELECT id,email FROM users WHERE email IN ('admin@example.com','staff@example.com');` + tenant slug `default` — carry the public `bcrypt('demo1234')` password. Remove.
3. **Legacy plaintext tokens (only if migrating existing DB):** `SELECT count(*) FROM calendar_connections WHERE refresh_token_encrypted NOT LIKE 'v1:%';` and `SELECT count(*) FROM users WHERE google_refresh_token IS NOT NULL;` → force reconnect, then null the plaintext column.
4. **Synthetic platform data:** seeded announcements/promotions, synthetic `email_suppressions`/`processed_stripe_events`, snapshot tables, and the deactivated `business` plan row (`prelaunch-cleanup.sql:180-186` already targets these).

**Preserve:** `plans`, `cron_runs`, the super-admin user/tenant (`slug='zentromeet'`), and all schema/migrations/enums/FKs. `scripts/prelaunch-cleanup.sql` already encodes this preserve-set with a hard identity-assertion abort guard — it is the correct tool; **do not delete production data without explicit approval.**

## 28. Remaining manual actions (cannot be done from the repo)

**Blocking for web launch:**
1. **Legal:** fill entity/address/jurisdiction/effective-date in `/privacy` + `/terms`; counsel review; confirm `privacy@`/`support@zentromeet.com` inboxes.
2. **Google verification:** with `/privacy` live, confirm the OAuth consent screen is "In production"/verified and `GOOGLE_REDIRECT_URI` matches Console exactly.
3. **Stripe prod env:** confirm `STRIPE_PRICE_*_MONTH/_YEAR` (or `_MONTHLY/_YEARLY` — now both work) are populated, `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` set (live mode), webhook endpoint subscribed; confirm migration `0066` applied (`SELECT slug,price_monthly_cents FROM plans;`).
4. **Cron registration:** install `docs/operations/cron-manifest.md` on the host; verify via `/api/health` + `SELECT job_name,status,started_at FROM cron_runs`.
5. **SES:** confirm out-of-sandbox + quota; SPF/DKIM/DMARC published; SNS bounce/complaint subscription confirmed; `email_suppressions` table applied; set `APP_BASE_URL` (HTTPS) + `EMAIL_FROM` in the PM2 env.
6. **Secrets:** confirm `JWT_SECRET` (≥32B, unique), `COMMS_ENCRYPTION_KEY` (64-hex), `STRIPE_WEBHOOK_SECRET` set with strong entropy; `COOKIE_INSECURE` **not** set; `ALLOW_DEV_SIMULATION` unset/false in prod.
7. **Infra:** confirm PM2 startup persistence + topology (single-instance recommended given in-memory rate limiter), SSL renew timer, backups exist + a test restore, OS log rotation, disk/RAM headroom, an external uptime monitor on `/api/health`.

**If promoting Outlook:** complete Azure publisher verification + register both redirect URIs + scopes; produce the Azure runbook.

**Recommended (not strictly blocking):** apply the calendar-connect CSRF-nonce patch (§9) and test the connect round-trip; run `npm audit fix` for `qs`; add `is_demo=false` to admin rollups or remove demo tenants.

## 29. Launch-day checklist

- [ ] `main` updated with audit fixes; `next build` passes on host/CI; `npm test` green.
- [ ] `/privacy` + `/terms` finalized (entity details, counsel-reviewed) and reachable at both `zentromeet.com` and `app.zentromeet.com`.
- [ ] Google consent screen verified; calendar connect tested end-to-end with a real Google account.
- [ ] Stripe live keys + price IDs set; a real test-mode checkout completes and the webhook updates `currentPlan`.
- [ ] Full cron set registered; `/api/health` all-green; calendar `webhook_channels` expiry advances after a renew run.
- [ ] SES out-of-sandbox; a booking confirmation email arrives at Gmail **and** Outlook with the ICS.
- [ ] Secrets confirmed; `ALLOW_DEV_SIMULATION` off; `COOKIE_INSECURE` unset.
- [ ] Production cleanup (§27) reviewed/approved; demo data handled.
- [ ] Smoke test: signup → onboarding (now produces a **bookable** page) → public booking in incognito → confirmation email → cancel via link → dashboard shows cancelled → upgrade (Stripe test) → webhook updates plan → `/admin` shows real (non-$0) revenue.
- [ ] Mobile: confirm **no** app-store listing or marketing claims a native app.

## 30. First-72-hour monitoring checklist

- [ ] `/api/health` polled by an external uptime monitor; alert on 503.
- [ ] Watch `email_fail` and `smtp_health_fail` JSON log lines; SES bounce <5% / complaint <0.1% (the suppression check in health surfaces this).
- [ ] Stripe webhook delivery dashboard — investigate any failure; confirm `processed_stripe_events` growing and `billing_transactions.status='paid'` rows appear; `/admin/finance` shows non-zero revenue.
- [ ] `SELECT job_name, MAX(started_at) FROM cron_runs GROUP BY job_name;` — confirm reminders, holds, push, webhook-renew, analytics all firing.
- [ ] Calendar: watch for a spike in `needs_reconnect`; confirm `webhook_channels` expiry keeps advancing (renew cron healthy).
- [ ] Booking race signal: watch `409 Slot just taken` rate and any `pending_payment` backlog (`expired_payment_holds` health check).
- [ ] Auth: `failed_logins_24h` / `suspicious_activity_24h` health metrics for credential-spray.
- [ ] EC2: RAM/disk; `dmesg | grep -i oom`; PM2 restart count.

## 31. Post-launch backlog (prioritized)

1. **P1 follow-ups:** multi-tenant login email scoping (`tenantSlug`); calendar-connect CSRF nonce (all providers); `tenant-patch-no-audit`; cron-heartbeat coverage for all jobs; customer-facing billing emails.
2. **DB hygiene:** regenerate the Drizzle journal/snapshot so tooling matches reality (carefully, never `push` against prod); add `is_demo=false` to admin rollups; scrub legacy plaintext tokens.
3. **Security hardening:** app-wide CSP with nonces; SSRF guard on the outbound tenant webhook; rate-limit + jti-revocation backed by a shared store (or commit to single-instance); avatar upload magic-byte sniff; stop logging full OAuth token objects; `npm audit` major bumps.
4. **Reliability:** object storage for uploads (remove EC2-disk SPOF); implement `MAINTENANCE_MODE`; install Sentry or remove the dead `SENTRY_DSN` claim; `cron_runs` retention pruner; advisory locks on long crons.
5. **Product/UX:** email verification + welcome; per-service confirmation message / duplicate / visibility; show yearly pricing; render customer emails in the **customer's** timezone.
6. **Mobile (separate project):** scaffold the actual app (Expo/RN), wire the existing backend, build Codemagic/EAS pipelines, store assets, account-deletion flow, then verify.

---

## 32. Appendix — full findings index

106 findings (1 refuted: `slack-alerts-claim-not-wired` — `/for/agency` advertised "Slack alerts" but verifier confirmed the marketing page does **not** make a false claim / the scaffold is appropriately gated). Effective severity after verification: **P0=3, P1=16, P2=46, P3=40.** Per-finding evidence (file:line), root cause, and proposed fix are retained in the audit working set; the launch-blocking and P1 items are detailed in §3–§20 above. Areas audited: auth-session, tenant-isolation, billing-stripe, pricing-reconciliation, booking-engine, appointment-lifecycle, calendar-google, calendar-microsoft, email-ses, reminders-cron, super-admin, public-site-seo-legal, security-hardening, database-integrity, mobile-readiness, infra-ops, onboarding-appttypes.

> **Honesty statement:** Nothing in this report is marked working without code-level evidence. Items that genuinely require the running production system, live third-party accounts, or the EC2 host are labeled "cannot verify / manual" rather than asserted. The launch recommendation reflects actual end-to-end readiness, not merely that builds/tests pass.

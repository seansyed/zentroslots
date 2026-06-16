# ZentroMeet — Pre-Launch Audit: Appointment Emails, Mobile Push, Stripe Billing

> **Follow-up (2026-06-16, commit `8015789`):** the implementable items below are
> now closed in code + deployed — subscription reconciliation, plan-catalog drift
> detector + DB price-id mapping, push receipt processing + dead-token pruning,
> cancellation/reschedule email dedup, paid-hold slot visibility. Remaining items
> are operator/device-blocked. See **[PRELAUNCH_BLOCKER_CLOSEOUT_REPORT.md](PRELAUNCH_BLOCKER_CLOSEOUT_REPORT.md)**.

**Date:** 2026-06-16 · **Branch:** main · **Code commit audited + remediated:** `69cacdf`
(deployed to prod; rollback target `a8de5c2`) · **Prod:** app.zentromeet.com (PM2
`scheduling-saas` @ 35.83.95.42) · **Method:** 10-agent evidence-based code audit +
read-only production DB/cron/config/log evidence + post-deploy SMTP/webhook/health smoke.

Identifiers are masked. No secrets are printed. No real customer was emailed/pushed.
No destructive SQL, no `drizzle-kit push`, no live refund, no real card.

---

## OVERALL LAUNCH STATUS — **NOT READY (SAFE TO LAUNCH = NO)**

0 P0 defects. 24 P1 findings: **9 FIXED + deployed**, the rest flagged below. The
launch gate stays **NO** because of **operator/device-blocked** items, not code defects:

- **Mobile push is unverified in production** — `push_tokens` = 0 and `push_deliveries`
  = 0 rows ever. Nothing has registered a token or been delivered. Requires physical
  Android device testing + a signed iOS TestFlight build (both operator actions).
- **iOS push credentials incomplete** — no APNs key / signed TestFlight build yet.
- **Stripe SaaS subscription flow has zero production evidence** — `processed_stripe_events`
  = 0, `billing_transactions` = 0, tenants with a `stripe_subscription_id` = 0. The
  plumbing is solid (endpoint live + signature-validating + idempotent) but no real
  subscription has ever flowed end-to-end in prod.
- **Plan reconciliation drift** — DB `plans.stripe_price_id_*` are NULL while price IDs
  live in env; three plan catalogs disagree (details below).

Email is the most mature surface and is largely **VERIFIED** (fresh post-deploy SES send 6/6).

---

## Status legend
VERIFIED WORKING · FIXED · PARTIALLY VERIFIED · OPERATOR ACTION REQUIRED · BLOCKED · NOT IMPLEMENTED · NOT APPLICABLE

---

# PART A — APPOINTMENT EMAILS

## Architecture (VERIFIED)
- **Single mailer**: `lib/email.ts` (multi-provider: Resend → Postmark → SMTP → stub by
  precedence of which key is set). **Prod = AWS SES via SMTP** (`SMTP_HOST=email-smtp.us-east-1.amazonaws.com`,
  `SMTP_USER/PASS` set; no AWS API creds — SMTP interface only).
- **From** = `EMAIL_FROM="ZentroMeet <no-reply@zentromeet.com>"` ✓ (correct branded sender).
- **Orchestrator**: `lib/communications/engine.ts triggerAutomation()` — idempotency →
  tenant gate → automation-rule gate → customer-pref gate → template render → send →
  `communication_logs` row. Never throws.
- **No queue** — synchronous direct send; reminders + delayed automations are cron-driven.
- **Delivery log** = `communication_logs` (provider, provider_message_id, status, event_type,
  skipped_reason, sent_at). **Suppression** = `email_suppressions` + pre-send `isSuppressed`
  check on every send. **Bounce/complaint** = `POST /api/webhooks/ses` (SNS → signature verify
  → permanent bounce/complaint → suppression upsert + admin alert).

## Production delivery evidence (VERIFIED)
- `communication_logs`: **102 rows — 4 sent (SMTP, 0 failures), 98 skipped**. **All 98 skips
  = `skipped_reason = demo_tenant`** (intentional, demo workspaces correctly excluded).
- Events sent for real tenants: `appointment.created` ×2, `appointment.reminder_24h` ×1,
  `appointment.reminder_1h` ×1. Last real send 2026-06-16 03:45. **Zero failures ever.**
- **Fresh post-deploy SMTP send** (`email:smoke admin@zentromeet.com`, operator address):
  **6/6 OK via SMTP** — confirmation + reminder(24h) + reminder(1h) + cancellation +
  reschedule + adminNotify all rendered and delivered. "SES wire is live."
- Health endpoint: `smtp_transport ok`, `reminder_delivery ok (sent=1 failed=0)`,
  `email_suppressions ok (bounce_24h=0 complaint_24h=0)`.

## Recipient matrix (code-derived)
| EVENT | CUSTOMER | STAFF | TENANT ADMIN | PLATFORM ADMIN | TEMPLATE | SEND TIME | DUP PROTECTION |
|---|---|---|---|---|---|---|---|
| appointment.created (free/paid-after-confirm) | ✅ | via ICS attendee only | ❌ (in-app `notifications` only) | ❌ | confirmation | on confirm | ✅ comm_logs idempotency |
| payment completed (paid) | ✅ (confirmation) | — | ❌ | ❌ | confirmation | on `checkout.session.completed` | ✅ webhook event-id claim |
| reschedule (web/customer/mobile) | ✅ | ICS attendee | ❌ | ❌ | reschedule | inline on reschedule | ⚠️ **no comm_logs dedup** (P1, flagged) |
| cancellation (web/customer/mobile) | ✅ | ICS attendee | ❌ | ❌ | cancellation | inline on cancel | ⚠️ **no comm_logs dedup** (P1, flagged) |
| auto-cancel (payment-hold expiry) | per policy | — | ❌ | ❌ | cancellation | holds:expire cron | ✅ status-gated |
| reminder 24h / 1h | ✅ | ❌ | ❌ | ❌ | reminder | reminders cron (±30m) | ✅ **now atomic-claim (FIXED)** |
| waitlist slot available | ✅ (winner) | ❌ | ❌ | ❌ | waitlist | on slot release | ✅ comm_logs + **recipient FIXED** |
| reminder/admin delivery failure | — | — | ✅ admin@ | ✅ admin@ | adminNotify | on failure | ✅ dedupe-keyed |

Notes: emails are **ZentroMeet-branded only** (no per-tenant logo/color yet — enhancement,
not a blocker). Staff are notified via the **ICS attendee** on the customer email, not a
separate staff email (operationally acceptable; flag if a dedicated staff email is desired).

## Timezone (VERIFIED for live path)
- Live system templates format the time with `formatInTimeZone(start, tz, "…h:mm a zzz")`
  — **always carries an explicit tz abbreviation** (`lib/email.ts:480`). tz = staff/business tz.
- **FIXED**: custom-template variable path now exposes `{{appointment_timezone}}` and the
  `safeFormat` fallback emits a **UTC-labeled** string instead of a raw ISO timestamp.
- **PARTIALLY VERIFIED / flagged (P1)**: emails show the **business (staff) timezone**, not a
  per-customer timezone — the customer's tz is not captured at public-booking time. The time
  is labeled, so it is unambiguous, but a customer in another zone sees the business's local
  time. Capturing customer tz needs a schema migration + product decision → deferred.

## Email findings
- **FIXED** — Reminder cron could double-SEND across overlapping runs and could remind a
  booking cancelled mid-tick. Now atomically claims each reminder
  (`UPDATE … WHERE flag IS NULL AND status='confirmed' RETURNING`) before sending; crash
  releases the claim for retry. `scripts/send-reminders.ts`.
- **FIXED** — Waitlist "slot available" email went to the **cancelling** customer, not the
  **waitlist winner** (winner never notified). Added `TriggerArgs.recipientOverride`; waitlist
  now emails the winner. `lib/waitlists/notifications.ts`, `lib/communications/engine.ts`.
- **FIXED** — `{{appointment_timezone}}` variable + UTC-labeled `safeFormat` fallback.
- **P1 (flagged, deferred)** — Cancellation + reschedule emails are sent via inline paths with
  **no `communication_logs` dedup row** → no idempotency if double-triggered (low frequency:
  one-shot user actions). Recommended: route through `triggerAutomation('appointment.cancelled'
  /'…rescheduled')` or write a keyed comm_logs row. Touches 4 send paths — deferred to avoid
  regression in this pass.
- **P2 (flagged)** — `provider_message_id` is **not captured** for SMTP sends (logged as
  `none`); weakens per-send delivery traceability. Recommend persisting nodemailer
  `info.messageId`.
- **P2 (flagged)** — Reminder marks the flag even on a provider `failed` (deliberate, alert-only
  design) — preserved; transient SES blip = missed reminder. Acceptable given admin alerting +
  the new crash-retry.
- **P2 (doc)** — `docs/operations/ses-failures.md` references a non-existent `EMAIL_PROVIDER`
  override + wrong `POSTMARK_SERVER_TOKEN` name (real var is `POSTMARK_TOKEN`).

## Email provider/infra config (VERIFIED, masked)
SES region us-east-1 · SMTP creds set · `EMAIL_FROM` correct · `ADMIN_EMAIL=admin@zentromeet.com`
· no AWS API keys (SMTP-only). **SPF/DKIM/DMARC + SES production-access (sandbox?) + verified
identities are AWS-console facts** → **OPERATOR ACTION REQUIRED** to confirm (cannot be read
from the box; the live 6/6 SES send proves the wire works and the sender is accepted).

---

# PART B — MOBILE PUSH NOTIFICATIONS

## Architecture (VERIFIED from code/DB)
| | |
|---|---|
| ANDROID PROVIDER | Expo Push Service → FCM |
| IOS PROVIDER | Expo Push Service → APNs |
| TOKEN FORMAT | Expo push token (`push_tokens.expo_token`) |
| TOKEN STORAGE | `push_tokens` (expo_token, user_id, tenant_id, platform, device_label, last_used_at) |
| TOKEN OWNER | server-derived (`requireUser()` on `/api/mobile/push-tokens`) |
| TENANT SCOPE | per (user_id, tenant_id); enqueue selects tokens by staffUserId+tenantId |
| DEVICE SCOPE | multi-device (one row per token) |
| REFRESH | on app focus; re-registers fresh token |
| DELIVERY RECEIPTS | `push_deliveries` has `expo_receipt_id` column (architected); **receipt-check pass NOT implemented** (P1) |
| RETRY STRATEGY | `push_deliveries.attempt_count` + `next_retry_at` + `last_error`; `push:deliver` cron every 1 min |

Queue: booking events → `enqueueBookingPush` inserts `push_deliveries` rows → `push:deliver`
cron sends via Expo → records ticket. **Demo tenants are suppressed.** Payload =
`{type, bookingId, tenantId}` (structured nav data; **no PII/payment data** in data_payload).
Token registration requires auth, owner is server-derived — clients cannot register for
another user. ✅ **Tenant isolation verified** (enqueue filters by tenantId; tokens scoped per user/tenant).

## Production evidence (the blocker)
- **`push_tokens` = 0 rows. `push_deliveries` = 0 rows.** Push has **never** been exercised in
  production — no token registered, no delivery attempted.
- `push:deliver` cron **is installed and running** (every minute; log 13:22 `processed=0 sent=0`).
  Earlier audit doubt about the cron being installed is **RESOLVED** — it runs.
- Net: the push pipeline is built and the worker runs, but **delivery is entirely unverified**.

## Push events (code)
Wired: `booking_created`, `booking_rescheduled`, `booking_cancelled`. Defined-but-not-enqueued:
`booking_reminder` (reminders are email-only). No push for paid/confirmed/staff-assignment/message.

## Push findings
- **FIXED** — Sign-out detached **all** of a user's device tokens; now detaches only the
  current device (passes the cached token; server already supports single-token delete).
  `mobile/src/api/pushTokens.ts`, `mobile/src/hooks/usePushNotifications.ts`.
- **FIXED** — Push body's absolute time (>24h) was formatted in **server-local** tz; now
  formatted in the **staff timezone with an explicit abbreviation** (same contract as the
  appointment-time fix). `lib/push/enqueue.ts`. (Covered by new tests.)
- **FIXED** — Mobile settings copy promised "reminders" push that isn't sent; corrected to
  "new bookings, reschedules, and cancellations." `mobile/app/settings/notifications.tsx`.
- **P1 (flagged)** — No Expo **receipt-check** pass → `DeviceNotRegistered` dead tokens are
  never pruned. `push_deliveries.expo_receipt_id` exists; add a second cron to GET receipts and
  delete dead tokens. Low urgency until tokens exist.
- **P2 (decision)** — Push body includes the customer's **full name** (staff-facing). Standard
  for calendar-style apps; flagged as a privacy-posture decision (genericize if desired).

## Device tests
- **ANDROID — BLOCKED / OPERATOR ACTION REQUIRED**: physical device tests (fresh/upgrade
  install, permission allow/deny, foreground/background/force-closed, tap routing, new/
  reschedule/cancel) cannot run from this environment. 0 tokens in prod = unverified.
- **iOS / iPad — BLOCKED**: requires a signed TestFlight build + APNs key (operator). Per the
  iOS CI rewrite, the native build is ready but **not yet built/signed**. No iOS push results
  are fabricated.
- **PUSH TIMEZONE** — code-correct (FIXED + tested); **device-unverified** (no tokens).
- **DEEP LINKS** — code routes via `data_payload.bookingId` to the auth+tenant-gated detail
  screen; **device-unverified**.

---

# PART C — STRIPE BILLING & PAYMENTS

## Architecture (VERIFIED, masked)
- **SaaS subscriptions** → **platform** Stripe account (`STRIPE_SECRET_KEY = sk_live_***`
  [LIVE], `STRIPE_WEBHOOK_SECRET = whsec_***`). No publishable key set → **server-side hosted
  Checkout** (no client Stripe.js). API version **not pinned** (P2).
- **Appointment payments** → **per-tenant** model via `tenant_payment_providers` (Connect-style
  vault; encrypted secret/webhook per tenant). **`tenant_payment_providers` = 0 rows** → no
  tenant has connected a payment provider; paid public bookings are effectively dormant in prod.
- **Stripe Connect (platform-level)**: `STRIPE_CONNECT_WEBHOOK_SECRET` not set; per-tenant vault
  is the model. **PARTIALLY APPLICABLE** — architected, unused (0 providers).
- Idempotency table `processed_stripe_events`; ledger `billing_transactions`.

| | |
|---|---|
| STRIPE MODE | **LIVE** (platform) |
| STRIPE ACCOUNT | masked; sk_live + whsec configured |
| STRIPE CONNECT | per-tenant vault architected, **0 connected** |
| WEBHOOK ENDPOINT | `/api/webhooks/stripe` — **live, rejects unsigned (HTTP 400)** ✅ |
| WEBHOOK SIGNATURE | `stripe.webhooks.constructEvent` on RAW body ✅ |
| WEBHOOK IDEMPOTENCY | `tryClaimStripeEvent` atomic INSERT…ON CONFLICT on event_id; dup → 200 skip ✅ + ledger dedup on `stripe_event_id` |

## Webhook inventory (VERIFIED handlers)
`checkout.session.completed` (booking-payment branch + subscription branch), subscription
created/updated/deleted, invoice paid/payment_failed, charge.refunded, plus signature-failure
admin alert. Each: signature-validated, event-id-claimed (idempotent), tenant looked up from
metadata + validated, no cross-tenant mutation, admin-alerted on signature failure. **S2 audit
concern (re-firing post-confirmation hooks on retry) is NOT a defect** — the top-level event-id
claim returns 200 before any handler runs on a duplicate.

## Production evidence
- **`processed_stripe_events` = 0, `billing_transactions` = 0, tenants with
  `stripe_subscription_id` = 0.** No Stripe webhook has ever been processed in prod; the 4
  "paid" tenants (solo×2, pro×1, enterprise×1) were set **manually** (1 has a
  `stripe_customer_id`, none a subscription id). → **SaaS Stripe flow UNVERIFIED in prod.**
- `payments:reconcile` cron runs daily (`eventsScanned=0 stuckPendingBookings=0`).
- `expired_payment_holds` health = `none`; `pending_payment` bookings = 0; `holds:expire` cron
  every 5 min (`candidates=0`). → **payment-hold lifecycle healthy** (no orphans).

## Appointment payments
- **PUBLIC paid** (VERIFIED in code; dormant in prod): `pending_payment` + Checkout session +
  15-min hold + slot constraint; `checkout.session.completed` confirms (idempotent); abandoned
  → `holds:expire` cancels + releases; slot-taken race → auto-refund. **PAYMENT_HOLD_MINUTES =
  15** (code default; prod unset → 15; `.env.example` **FIXED** 30→15).
- **INTERNAL OPERATOR** (VERIFIED PRESERVED — rule 13): `isInternalOperatorBooking` makes an
  authenticated tenant-staff booking via `POST /api/bookings` **skip the hold + confirm
  immediately + not auto-cancel**; public/client role cannot bypass. **Intact.**
- **FREE** (VERIFIED in code): no Checkout, no hold, no billing email; confirms directly.
- **P1 (policy, flagged)** — Cancelling a confirmed PAID booking issues **no automatic refund**
  (legacy platform path has no in-app refund). Refund-on-cancel is a business policy decision;
  recommend a config flag + a "refund manually in Stripe" notice. Dormant (0 paid bookings).
- **P1 (flagged)** — `pending_payment` soft-holds do **not** remove the slot from the public
  availability grid (DB constraints are the backstop) → brief double-show during the 15-min
  hold. Dormant (0 connected providers). Fix when paid bookings go live.

## SaaS subscriptions & plan reconciliation
| PLAN | DB monthly/yearly (¢) | env Stripe price IDs | DB `stripe_price_id_*` | active |
|---|---|---|---|---|
| free | 0 / 0 | — | NULL | ✓ |
| solo | 1000 / 11000 | SOLO_MONTH/YEAR (set) | **NULL** | ✓ |
| pro | 3000 / 33000 | PRO_MONTH/YEAR (set) | **NULL** | ✓ |
| team | 10000 / 110000 | TEAM_MONTH/YEAR (set) | **NULL** | ✓ |
| enterprise | 25000 / 275000 | ENTERPRISE_MONTH/YEAR (set) | **NULL** | ✓ |
| business | 3900 / 39000 | — | NULL | inactive |

- **P1 — Plan reconciliation FAILS (flagged):** three catalogs disagree — `lib/plans.ts`
  constants vs the `plans` DB table vs env Stripe price IDs. **Checkout uses the env price IDs**
  (works), but `plans.stripe_price_id_monthly/yearly` are **NULL for every plan**, so admin
  MRR/"sellable" analytics are unreliable. Recommend: make `lib/plans.ts` the single source of
  truth and re-seed the `plans` table (reviewed, non-destructive UPDATE) — needs the prod env
  price IDs → **OPERATOR-assisted data step**. Legacy `business` plan + bare `STRIPE_PRICE_PRO/TEAM`
  env vars are vestigial.
- **FIXED** — `billingValidator` orphan/desync checks read the legacy never-updated
  `tenants.plan`; now read the authoritative `current_plan`. (`plan`==`current_plan` for all
  tenants today, so no live mismatch — the validator was dead code.)
- **P1 (flagged)** — No DB↔Stripe **subscription** reconciliation script; the daily
  `reconcile-tenant-payments.ts` reconciles appointment-payment events, not subscriptions.
  Recommend a read-only subscription recon (retrieve each `stripe_subscription_id`, compare
  status/plan). Nothing to reconcile yet (0 subscriptions).
- TRIALS / UPGRADES / DOWNGRADES / CANCELLATION / PAYMENT FAILURE / CUSTOMER PORTAL —
  **code present, PARTIALLY VERIFIED** (handlers exist + unit-tested in the 755-test suite;
  **no real production subscription has exercised them**). Customer portal is `requireRole('admin')`
  + tenant-scoped (no cross-tenant access). REFUNDS — handler + `charge.refunded` present;
  not exercised; no live refund performed (per rules).
- STRIPE DATABASE RECONCILIATION — `payments:reconcile` daily, 0 discrepancies; subscription
  recon = NOT IMPLEMENTED (flagged).

---

# PART D — OBSERVABILITY & ADMIN ALERTS (VERIFIED)
- **Health** `GET /api/health` — 26 checks (db, smtp_transport, reminder_delivery,
  email_suppressions, expired_payment_holds, billing_ledger, tenant_payment_vault,
  cloudflare_edge, auth/security, governance…), all green, `env=production`.
- **Admin alerts** (`adminNotify` → admin@zentromeet.com, dedupe-keyed): reminder delivery
  failure, worker crash, Stripe webhook signature failure, bounce/complaint. ✅
- **Crons** (ubuntu crontab, all running w/ structured logs): reminders /15m, holds:expire /5m,
  push:deliver /1m, payments:reconcile daily, automations /5m, recurring:materialize /15m,
  waitlists:expire /10m, calendar renew/drift, **automated DB backup 03:30 + healthcheck +
  weekly verify + monitor /5m**. ✅
- Gap (P2): no `push_deliveries` staleness check in `/api/health`; SES bounce/complaint depends
  on the SNS→`/api/webhooks/ses` wiring being configured in AWS (OPERATOR to confirm SNS topic).

---

# PART E — TESTS ADDED
`tests/prelaunch-audit-fixes.test.ts` (8): `appointment_timezone` variable rendering + whitelist;
push time tz labeling (>24h staff-tz w/ abbrev, <24h relative, <60m minutes, garbage-tz → UTC
fallback). Existing suite already covers webhook signature/idempotency, operator bypass, hold
expiry, reminder eligibility, plan constants, tenant isolation (755 total).

---

# PART F — END-TO-END SCENARIOS (status)
| Scenario | Status |
|---|---|
| 1 Free public booking (email/reminder/reschedule/cancel, no Stripe) | PARTIALLY VERIFIED (code + email wire); push device-blocked |
| 2 Paid public booking → paid | PARTIALLY VERIFIED (code); dormant in prod (0 connected providers) |
| 3 Paid public booking → abandoned (hold expiry) | VERIFIED healthy (0 stuck holds; holds:expire cron) |
| 4 Paid mobile operator booking (no hold, survives >20m) | VERIFIED PRESERVED (operator bypass; 0 stuck holds) |
| 5 Reschedule (web/mobile/email/push) | PARTIALLY VERIFIED (email/code); push device-blocked; dedup P1 flagged |
| 6 Cancellation | PARTIALLY VERIFIED (email/code); push device-blocked; dedup P1 flagged |
| 7 SaaS subscription | PARTIALLY VERIFIED (code + endpoint live + idempotent); **no real prod subscription** |

---

# PART G — VALIDATION (all green)
```
BACKEND TYPECHECK:    PASS (tsc 0)
FULL BACKEND SUITE:   PASS 755/755 (8 new)
WEB BUILD:            PASS (next build)
MOBILE TYPECHECK:     PASS (tsc 0)
MOBILE TESTS:         PASS 75/75
EXPO DOCTOR:          PASS 18/18
ANDROID EXPORT:       PASS
IOS EXPORT:           PASS
ANDROID PREBUILD:     PASS (--clean; reverted)
EMAIL ENV AUDIT:      done (masked) — SES SMTP us-east-1, From correct
PUSH CREDS AUDIT:     Expo Push; iOS APNs key NOT configured (operator)
STRIPE ENV AUDIT:     sk_live + whsec set; no test keys in prod; no pk (hosted checkout)
WEBHOOK AUDIT:        /api/webhooks/stripe live, 400 unsigned, idempotent
CRON AUDIT:           all jobs running (mtimes fresh)
PROD HEALTH:          ok=true, 26/26 checks green
```

# PART H — DEPLOYMENT (done)
```
COMMIT:               69cacdf (pushed origin/main)
ROLLBACK COMMIT:      a8de5c2
MIGRATIONS:           NONE (no schema change)
BACKUP:               ~/db-backups/pre-deploy-audit-20260616-131938.sql.gz (1.6M, restore-list verified)
BUILD:                once (NODE_OPTIONS=1024 npm run build) OK
RESTART:              pm2 restart + pm2 save (online)
EDGE HEALTH:          /api/health 200, /api/auth/me 401
WEBHOOK:              POST /api/webhooks/stripe unsigned → 400 (post-deploy)
CRONS:                push-deliver/reminders/holds-expire fresh post-deploy
EMAIL SMOKE:          email:smoke admin@zentromeet.com → 6/6 OK ("SES wire is live")
```

# PART I — MOBILE / CODEMAGIC
```
ANDROID VERSION CODE: 16 (was 15) — mobile code changed
IOS BUILD NUMBER:     12 (was 11)
CODEMAGIC REQUIRED:   YES — operator runs android-preview (vc16) for device push QA; iOS native build needs ASC API key integration + APNs
PRODUCTION AAB:       NOT created (per instruction)
TESTFLIGHT/APP STORE: NOT submitted (per instruction)
```

---

# OPERATOR ACTIONS REQUIRED (launch gating)
1. **Android push device QA** — build android-preview (vc16) on Codemagic, install, verify
   token registers (`push_tokens` > 0) + new/reschedule/cancel push delivers + tap routes +
   time matches web. (BLOCKER)
2. **iOS push** — configure APNs key + signed TestFlight build (native iOS workflow ready),
   then device QA on iPhone + iPad. (BLOCKER)
3. **Stripe SaaS end-to-end (test mode)** — run one real test-mode subscription through
   Checkout → confirm `processed_stripe_events`/`billing_transactions`/`stripe_subscription_id`
   populate; confirm the Stripe Dashboard webhook endpoint = `https://app.zentromeet.com/api/webhooks/stripe`.
4. **Plan reconciliation** — populate `plans.stripe_price_id_monthly/yearly` from env (reviewed
   UPDATE) or drop the DB dependency; retire the legacy `business` plan + bare PRO/TEAM env vars.
5. **SES** — confirm production access (out of sandbox), SPF/DKIM/DMARC on zentromeet.com, and
   the SNS→`/api/webhooks/ses` bounce/complaint wiring (AWS console).

---

# FINAL SUMMARY
```
SAFE FOR ANDROID PRODUCTION AAB:  NO (push not device-verified)
SAFE FOR IOS TESTFLIGHT:          NO (APNs + signed build pending — operator)
SAFE FOR APP STORE REVIEW:        NO
SAFE TO LAUNCH:                   NO
```
**Why NO:** mobile push has zero production verification (0 tokens/deliveries; Android device +
iOS credentials are operator-blocked), the Stripe SaaS subscription flow has zero real
production evidence, and plan/price reconciliation has drift. Email is the strongest surface
(fresh SES 6/6 send, healthy reminders/suppression, demo skips correct). Once operator actions
1–4 are complete and re-verified, re-run this audit's smoke checks to flip the gate.

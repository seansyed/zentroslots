# ZentroMeet — Pre-Launch Blocker Closeout Report

**Date:** 2026-06-16 · **Branch:** main · **Code commit deployed:** `8015789`
(rollback target `69cacdf`) · **Migration applied:** `0071_comm_logs_dedupe_key.sql`
(raw psql) · **Mobile:** unchanged this round → **versionCode 16 / iOS build 12** (no rebuild).

Continues [PRELAUNCH_EMAIL_PUSH_STRIPE_AUDIT_REPORT.md](PRELAUNCH_EMAIL_PUSH_STRIPE_AUDIT_REPORT.md).
Identifiers masked; no secrets printed; no real card; no live refund.

---

## OVERALL LAUNCH STATUS — **SAFE TO LAUNCH = NO**

Every implementable blocker is **closed in code, deployed, and evidenced**. The
gate stays **NO** because the remaining items are **operator/device/Apple/Stripe
actions** that cannot be performed from this environment and require physical
verification:

1. **Android push** — code-ready + deployed, but `push_tokens`=0 / `push_deliveries`=0;
   needs a physical-device install (vc16) to prove token registration + delivery.
2. **iOS push** — native build ready, but no APNs key + no signed TestFlight build yet.
3. **Stripe SaaS subscription lifecycle** — endpoint live + idempotent, but **0 real
   events** in prod; a full test-mode lifecycle must be run.
4. **Enterprise annual price** — Stripe charges **$2720** but the intended price is
   **$2750** (operator must fix the Stripe price).

Status legend: VERIFIED WORKING · FIXED · PARTIALLY VERIFIED · OPERATOR ACTION REQUIRED · BLOCKED · NOT IMPLEMENTED · NOT APPLICABLE

---

## Deployment (this round) — done + verified
```
COMMIT:            8015789 (origin/main)         ROLLBACK: 69cacdf
BACKUP:            pre-deploy-blockers-20260616-135440.sql.gz (1.6M, restore-list verified)
MIGRATION:         0071_comm_logs_dedupe_key.sql — applied via raw psql (column + index confirmed); NOT drizzle push
BUILD/RESTART:     once each; pm2 online + saved
EDGE HEALTH:       /api/health 200 · /api/auth/me 401 · webhook unsigned → 400
LOCAL HEALTH:      ok=true, env=production (26/26 checks green)
CRONS:             reminders/holds-expire/push-deliver fresh; payments:reconcile daily; push:receipts ADDED (*/5m, verified no-op at 0 tokens)
SES SMOKE:         email:smoke admin@zentromeet.com → 6/6 OK ("SES wire is live")
```

---

## WORKSTREAM 1 — Android push (BUILD READY; DEVICE = OPERATOR/BLOCKED)

**Build preflight (VERIFIED):** versionCode **16**, package `com.zentromeet.app`,
`EXPO_PUBLIC_API_BASE_URL=https://app.zentromeet.com` (no localhost), expo-notifications
plugin + `#2563EB` notification color + `default` channel, scheme `zentromeet`,
mobile tsc 0 / 75 tests / expo-doctor 18/18 (from vc16). Provider = **Expo Push → FCM**.

**Backend push fixes already live** (this + prior round): single-device logout token
removal; push body absolute time in staff tz; **receipt processing + DeviceNotRegistered
token pruning** (new this round). The `push:deliver` (1m) and `push:receipts` (5m) crons run.

**OPERATOR ACTION — Android device QA (BLOCKER).** No Codemagic API/device access here.
1. Codemagic → start **android-preview** on `main` (vc16) → install the APK.
2. Sign in → allow notification permission → confirm in prod:
   `SELECT platform, count(*) FROM push_tokens GROUP BY platform;` (expect ≥1 android row;
   `user_id`/`tenant_id` = the signed-in operator — server-derived).
3. From a second authenticated session create a controlled appointment for that staff;
   verify the new-appointment push (foreground / background / force-closed), tap → opens
   the correct appointment, **time matches web**. Repeat for reschedule + cancellation.
4. Log out → confirm only this device's token is removed (other devices keep theirs).
   Log in → token re-registers.
5. Capture per push: `push_deliveries` row (status sent→delivered), `expo_receipt_id`
   (masked), receipt result, displayed result, deep-link result, duplicate count.
**Do not mark Android push verified without a provider receipt + a physical display.**

---

## WORKSTREAM 2 — Stripe plan catalog (RECONCILED; 1 OPERATOR FIX)

**Canonical registry = `lib/plans.ts`** (plan key → name, monthly/yearly cents,
entitlement `limits`, env-var name per (key,interval)). The DB `plans` table is a
**decorative projection** — checkout/webhook/entitlements all read `lib/plans.ts` + env,
never the DB price columns.

**Checkout security (VERIFIED, already correct):** the client sends only a plan **enum**
+ interval; `priceIdFor()` resolves the price ID **server-side from the env allowlist**;
a client cannot supply an arbitrary price ID; the **free** plan isn't checkoutable
(creates no subscription). RBAC `requireRole(['admin'])` + tenant-scoped.

**DB mapping (FIXED):** `scripts/seed-plan-price-ids.ts` populated
`plans.stripe_price_id_monthly/yearly` for all 4 paid plans from the env-resolved IDs.

**Reconciliation table (live Stripe read, masked):**

| PLAN | DISPLAY | MONTHLY (registry/Stripe/DB) | ANNUAL (registry/Stripe/DB) | STRIPE PRODUCT | TRIAL | MISMATCH |
|---|---|---|---|---|---|---|
| solo | Solo | $10 / $10 / $10 ✓ | $110 / $110 / $110 ✓ | prod_…rfXrh | none | — |
| pro | Pro | $30 / $30 / $30 ✓ | $330 / $330 / $330 ✓ | prod_…tdhA0 | none | — |
| team | Team | $100 / $100 / $100 ✓ | $1100 / $1100 / $1100 ✓ | prod_…tUHAQ | none | — |
| enterprise | Enterprise | $250 / $250 / $250 ✓ | **$2750 / $2720 / $2750** ❌ | prod_…wTV2X | none | **annual** |
| free | Free | $0 (no Stripe) | n/a | — | n/a | — |

**Authority for entitlements** = `lib/plans.ts` `limits` (maxStaff/services/managers/…).
**Authority for money** = the active Stripe price. They agree for 7 of 8 prices.

**THE ONE DRIFT (OPERATOR ACTION):** Enterprise **annual** is **$2720 in Stripe** but the
**intended $2750** (every plan uses 11×monthly = 1-month-free: solo 110=11×10, pro 330=11×30,
team 1100=11×100 → enterprise 11×250 = **2750**). The Stripe price is the data-entry error.
Operator: create a corrected **$2750/yr** price on `prod_…wTV2X`, set
`STRIPE_PRICE_ENTERPRISE_YEAR` to it, re-run `scripts/seed-plan-price-ids.ts`, then
`scripts/audit-stripe-catalog.ts` must exit 0. (Safe today — 0 enterprise-annual subs.)

**Drift detector (FIXED):** `scripts/audit-stripe-catalog.ts` (read-only) compares
registry↔Stripe↔DB and exits 2 on any monetary mismatch — ran in prod, correctly flagged
the enterprise-annual drift. Run before launch + periodically.

---

## WORKSTREAM 3 — Stripe subscription E2E (CODE-VERIFIED; LIVE RUN = OPERATOR/BLOCKED)

Prod is **live-only** (no test keys, correctly). A real subscription lifecycle cannot be
driven from here (needs a browser + Stripe test account + test card). **Webhook
infrastructure is VERIFIED:** signature validation (unsigned → 400 in prod), atomic
event-id idempotency (`tryClaimStripeEvent`), secondary ledger dedup, admin-alert on
signature failure, plan resolved server-side from the price ID. Webhook is authoritative;
the browser redirect only carries a GA event, never grants access.

**OPERATOR ACTION — run the lifecycle in Stripe TEST mode** (isolated test keys + a test
tenant; do **not** mix test IDs into prod): free signup → monthly Checkout (test card
4242…) → `checkout.session.completed` → subscription created → `tenants.current_plan` +
`subscription_status` activate → invoice.paid → customer portal → upgrade (proration) →
downgrade → payment failure (4000 0000 0000 0341) → recovery → cancel-at-period-end →
resume → final cancel → duplicate-webhook replay (must dedup) → delayed/out-of-order.
Capture per stage: Stripe event id (masked), webhook receipt, idempotency result, DB
plan/status/trial/cancel_at_period_end, invoice state, portal authorization. After a real
subscription exists, `scripts/reconcile-subscriptions.ts` (below) verifies DB↔Stripe.

---

## WORKSTREAM 4 — Subscription reconciliation (IMPLEMENTED + DEPLOYED)

`scripts/reconcile-subscriptions.ts` — **read-only** DB↔Stripe compare for every tenant
with a `stripe_subscription_id`: `subscription_status`, `current_plan` (via
`planFromStripePriceId`, null-price = leave alone — same as the webhook), `trial_end`;
`current_period_end`/`cancel_at_period_end` emitted as informational metadata (no DB
column). Per-tenant isolation; structured JSON; **exit 2 on critical drift** (Stripe dead
+ DB still paid), exit 1 fatal; `adminNotify('subscription_reconcile_drift')` only on
genuine mismatch (hourly cooldown), never when clean. **No writes, no Stripe mutations.**
`npm run subscriptions:reconcile` (cron-ready; **not** auto-enabled — operator turns it on
after a real subscription exists). **Prod dry-run:** scanned 0, clean, exit 0.

---

## WORKSTREAM 5 — iOS / APNs (BUILD READY; SIGNING + APNS + DEVICE = OPERATOR/BLOCKED)

The native Codemagic iOS workflow is correct (`expo prebuild` derives `aps-environment`
from expo-notifications; automatic signing provisions the Push Notifications capability +
Apple Distribution cert + App Store profile; IPA validation; upload held behind
`PUBLISH_TO_TESTFLIGHT`). **No EAS / EXPO_TOKEN.** iOS build number 12, supportsTablet true.

**Critical operator note (APNs delivery):** because the backend pushes via the **Expo Push
API** with ExponentPushTokens, APNs delivery depends on an **APNs Auth Key (.p8)
registered with EXPO** for this project — Codemagic's signing only provisions the
*capability*, not delivery.

**OPERATOR ACTIONS (BLOCKER, in order):**
1. Confirm the `zentromeet_asc_api_key` App Store Connect API key integration + the
   `zentromeet_api` env group in Codemagic.
2. Apple Developer → Keys → enable **Apple Push Notifications service**, create an APNs
   Auth Key (.p8); **register it with Expo** for this project's iOS credentials
   (`eas credentials` → iOS → Push Notifications, or the Expo dashboard). Never commit/log the .p8.
3. Configure the `app_store_credentials` group; set `PUBLISH_TO_TESTFLIGHT=true` only when
   ready to upload.
4. Build → signed IPA → TestFlight (do **not** submit for App Store review) → wait for
   Apple processing.
5. Device QA on **iPhone + iPad**: permission allow/deny, token registration, foreground/
   background/terminated delivery, new/reschedule/cancel, correct timezone, sound, badge,
   deep link, logout cleanup, tenant isolation, portrait/landscape, iPad layout.
**Do not mark iOS push verified without TestFlight device evidence.** (CODEMAGIC_NATIVE_IOS_BUILD.md updated with the APNs-on-Expo step.)

---

## WORKSTREAM 6 — Remaining P1 hardening

| Item | Status | Notes |
|---|---|---|
| 6.1 Cancellation-email dedup | **FIXED + deployed** | All cancel paths route through `triggerAutomation('appointment.cancelled')` → comm_logs idempotency (one cancel per booking) + METHOD:CANCEL ICS. |
| 6.2 Reschedule-email dedup | **FIXED + deployed** | Reschedule paths route through `triggerAutomation('appointment.rescheduled', dedupeKey:'r:<new-start-epoch>')` — each legit move emails once; same-time retries dedup. Migration 0071 adds the keyed partial-unique index; NULL-key rows (confirmation/reminder/cancel) unchanged. |
| 6.3 Push receipt processing + invalid-token pruning | **FIXED + deployed** | `fetchExpoPushReceipts` + `scripts/process-push-receipts.ts` (cron */5m). ok→delivered; DeviceNotRegistered→failed + prune token; transient/pending→re-check. 6 unit tests. |
| 6.4 Customer timezone capture | **NOT REQUIRED** | Intended display rule = business/staff tz **with an explicit label** (system emails already render `…h:mm a zzz`). Capturing per-customer tz needs a migration + product change; not required by the rule. Documented, deferred. |
| 6.5 Refund-on-cancel policy | **DOCUMENTED, NOT IMPLEMENTED** | Policy decision (below). |
| 6.6 Paid-hold slot visibility | **FIXED + deployed** | `getBookingsInRange` now suppresses slots with a LIVE pending_payment hold (expired holds not suppressed; DB constraints remain the hard backstop). Operator/free unaffected. |

### 6.5 Refund-on-cancel — policy (decision required before implementing)
Today, cancelling a confirmed **paid** booking does **not** auto-refund. Recommended
policy: **no automatic refund on cancel** (refunds are a deliberate operator action via
the tenant Stripe dashboard / the existing `app/api/tenant/bookings/[id]/refund` route),
PLUS surface a clear "this paid booking was not refunded — refund manually if appropriate"
note in the cancel response. Auto-refund-on-cancel should be opt-in per tenant. **Dormant
in prod** (0 connected payment providers, 0 paid bookings). Implement only after the
business confirms the policy.

---

## VALIDATION
```
BACKEND TYPECHECK:  PASS (0)        FULL SUITE: PASS 761/761 (+6 push-receipts)
WEB BUILD:          PASS            MOBILE TYPECHECK: PASS (0)   MOBILE TESTS: 75/75 (unchanged)
CATALOG RECON:      ran in prod — 1 mismatch flagged (enterprise annual), exit 2
SUBSCRIPTION RECON: ran in prod (dry-run) — 0 subs, clean, exit 0
PUSH RECEIPTS:      worker ran in prod — no-op at 0 tokens, observability logged
SES:                6/6 smoke OK    WEBHOOK: 400 unsigned    PROD HEALTH: ok=true 26/26
```
Mobile gates (expo-doctor/exports/prebuild) unchanged from vc16 — **no mobile code changed**, so no rebuild/bump.

---

## FINAL STATUS
```
SAFE FOR ANDROID PRODUCTION AAB:  NO   (push not device-verified)
SAFE FOR IOS TESTFLIGHT:          NO   (APNs key + signed build pending — operator)
SAFE FOR APP STORE REVIEW:        NO
SAFE TO LAUNCH:                   NO
```
**Closed in code + deployed:** subscription reconciliation, plan-catalog drift detector +
DB price-id mapping, push receipt processing + dead-token pruning, cancellation +
reschedule email dedup, paid-hold slot visibility. **Remaining (operator/device):** Android
device push QA, iOS APNs + signed TestFlight + device QA, a full Stripe test-mode
subscription lifecycle, and the one Stripe enterprise-annual price correction
($2720 → $2750). When those pass, re-run the catalog audit (must exit 0), `reconcile-subscriptions`,
and the device/TestFlight checks to flip the gate.
```
P0 ISSUES:  NONE
P1 ISSUES:  enterprise annual price $2720≠$2750 (operator Stripe fix); refund-on-cancel policy (decision)
```

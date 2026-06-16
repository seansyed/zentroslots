# Incident Report — Mobile-Created Appointments Auto-Cancel

**Date:** 2026-06-16 · **Severity:** P0 (booking integrity) · **Customer impact:** none (blast radius = 2 internal test bookings) · **Status:** root cause confirmed; fix implemented + validated; deploy pending.

## Incident summary
Two appointments created from the installed ZentroMeet mobile app were automatically changed to `cancelled` ~15–20 minutes after creation, with no user action. Confirmed from production evidence (audit log + cron log + DB): both were **paid** services booked through the **public** `POST /api/bookings` endpoint, which placed them in a `pending_payment` 15-minute payment hold; the `holds:expire` cron (every 5 min) then cancelled them because the mobile app has no checkout UI to complete payment. No real customer appointments were affected.

## Affected appointments (masked)
Tenant `af66b982`. No PII collected.

| Booking | Created | Cancelled (cron) | Δ | Service price | Stripe session | internalNotes | customerId | mode | final status |
|---|---|---|---|---|---|---|---|---|---|
| `6629d7fe` | 2026-06-16 01:02:41 | 2026-06-16 01:20:06 | ~17.5 min | $450.00 | present (unpaid) | null | null | auto | cancelled |
| `e0249b6c` | 2026-06-15 23:05:33 | 2026-06-15 23:25:03 | ~19.5 min | $180.00 | present (unpaid) | null | null | auto | cancelled |

## Timelines
**APPOINTMENT A (`6629d7fe`)**
- 01:02:41 — created via `POST /api/bookings` (paid $450) → `status=pending_payment`, `payment_hold_expires_at ≈ 01:17:41` (now + `PAYMENT_HOLD_MINUTES`=15), Stripe checkout session created (never opened).
- ~01:17:41 — hold elapsed.
- 01:20:06 — `holds:expire` cron tick → `status=cancelled`, `payment_hold_expires_at=null`; audit `booking.payment_hold_expired` (`actor_user_id=NULL` → cron).

**APPOINTMENT B (`e0249b6c`)**
- 23:05:33 — created (paid $180) → `pending_payment`, hold ≈ 23:20:33.
- 23:25:03 — `holds:expire` cron tick → `cancelled`; audit `booking.payment_hold_expired` (cron).

`holds-expire.log` shows exactly two non-zero runs (`candidates=1 ok=1` ×2) — the two bookings.

## Root cause
`mobile/app/quick-create.tsx` → `mobile/src/api/appointments.ts create()` posts to the **public, payment-first** `POST /api/bookings`. That endpoint performs **no authentication on POST** (only IP rate-limit) — a logged-in operator is indistinguishable from an anonymous customer. For `service.price > 0` it diverts to the paid path (`createTenantVaultCheckout` / `createPendingPaymentBooking`, `lib/billing/paymentLifecycle.ts`), inserting `status='pending_payment'` + `payment_hold_expires_at = now + 15m`. The mobile app has no Stripe checkout UI, so payment never completes and the row stays `pending_payment` until the cron cancels it. (Free services insert `confirmed` directly — which is why free mobile bookings never auto-cancelled.)

Operator-created appointments belong on the authenticated `POST /api/tenant/appointments` (RBAC-gated, always `status='confirmed'`, no hold). Mobile used the wrong lifecycle.

## Triggering process
`scripts/expire-payment-holds.ts` (cron `*/5 * * * * npm run holds:expire`, external Linux crontab). Eligibility: `status='pending_payment' AND payment_hold_expires_at < now()` → `UPDATE … status='cancelled', payment_hold_expires_at=null`; audit `booking.payment_hold_expired`. It has **no internal/source exclusion** — it cannot distinguish an operator hold from an abandoned public checkout. This job is correct for public checkouts and is left intact; the fix removes operator bookings from the `pending_payment` state entirely so they never become eligible.

## Ruled out (with evidence)
- **Stripe webhook** — terminal state is `payment_failed`, not `cancelled`; resolves by `booking_id`/`stripePaymentIntentId` which never existed (no payment intent). Doubly excluded.
- **Calendar sync** — `onBookingCancelled` only deletes the external event downstream of an explicit cancel; never writes `status`.
- **Customer/staff cancel** — both require auth/token + a user action and audit `booking.cancel`, not `booking.payment_hold_expired`. None occurred.

## Blast radius / customer impact
Audit `booking.payment_hold_expired`, last 7 days: **total = 2** — exactly the two test bookings. `internal_notes` set = 0, had Stripe session = 2, paid = 2, free = 0, had customer = 0, all tenant `af66b982`. **Zero web-internal, zero free-service, zero real-customer appointments affected.** Containment: none required beyond the fix; the two test bookings will be recreated post-fix (Phase 16).

## Fix (smallest, server-authoritative, backend-only)
New `isInternalOperatorBooking(session, serviceTenantId)` in `lib/auth.ts`: true only when there is a valid tenant-user session whose tenant matches the service's tenant. In `app/api/bookings/route.ts` POST, `const internalOperator = isInternalOperatorBooking(await getSession(), service.tenantId)` gates both paid branches (`if (service.price > 0 && !internalOperator)` and `requiresPayment = … && !internalOperator`). An operator paid booking therefore falls through to the existing **confirmed** insert (no hold, no Stripe) — structurally ineligible for the `holds:expire` cron.

- **Server-authoritative:** authority is derived from the verified session + tenant match — never a client flag (public callers have no session → unchanged checkout/hold path). Not spoofable.
- **Backend-only:** the already-installed mobile app is fixed on deploy — no mobile rebuild, no Codemagic, no version bump (honors the build freeze).
- **Preserved untouched:** public Stripe checkout + hold expiry, free services, intake-form validation/persistence (mobile keeps posting to `/api/bookings`), reminders, calendar sync, tenant isolation, RBAC, the `holds:expire` cron.
- No schema change, no migration.

## Tests
- `tests/booking-source.test.ts` (4) — operator (admin/manager/staff) of the service tenant → internal (no hold); anonymous (null session) → not internal; cross-tenant session → not internal; authority is session-derived (no spoofable client param).
- Full backend suite + targeted booking/payment/hold tests — no regression.

## Deployment
Backend-only. Process: commit + push → pre-deploy PG backup → record prod commit → fast-forward prod to the exact commit → build once → PM2 restart once → `pm2 save` → verify `/api/health` → verify the `holds:expire` cron is still registered + the Stripe webhook endpoint healthy. (Filled in on deploy.)

## Rollback
Revert the `app/api/bookings/route.ts` gate + `lib/auth.ts` helper (single commit), rebuild, restart. No data migration to undo. The `holds:expire` cron and payment lifecycle are unchanged, so reverting restores the prior behavior exactly.

## Prevention & monitoring
- Operator bookings now confirm immediately; they cannot enter `pending_payment`.
- The `holds:expire` cron already emits a `payment_hold_backlog` admin alert when holds are overdue >10 min — monitors public-checkout hold health.
- Recommended follow-up (not required for this fix): a lightweight alert if any `booking.payment_hold_expired` row has `internal_notes`/operator provenance (defense-in-depth), and a dashboard count of auto-cancellations by origin.

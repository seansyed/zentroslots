# ZentroMeet Mobile — Profile Image, Upcoming Bookings, Calendar Month Nav & UI Polish

**Date:** 2026-06-15 · **Mobile:** Expo SDK 52 / RN 0.76.9 · **versionCode 13 / iOS build 9** · **Backend:** one additive `validStatuses` line in `/api/bookings` (deploy).

> Note: the screenshots referenced in the request were not attached as image files in the task payload; this work used the detailed written descriptions plus the current code as the baseline.

---

## 1 — Customer profile image (P0) — ROOT CAUSE = MISSING FEATURE, not a wiring bug

**Customers have no profile-image field anywhere in the product.** Verified across the whole stack: the `customers` table (db/schema.ts) has no avatar/image/photo column (only the `users`/staff table has `avatar_url`); both `GET /api/customers` and `GET /api/customers/[id]` select no image; the mobile `Customer` type had none; and **the WEB also renders customers with name-only initials** (`<Avatar name={clientName}>`, `<AvatarChip name={…}>`). So "RK" initials for Rashid Kazi is **correct and consistent** behavior for a customer with no stored photo — there is no real image to display, on web or mobile.

**What was done (mobile-only, forward-compatible):** the Avatar is now genuinely customer-image-capable so a real photo renders the instant the product stores one — without faking anything:
- `Customer.imageUrl` added + **absolutized** against the API origin (reuses `lib/url.ts absolutizeUrl`, the same helper that fixed staff avatars — RN `<Image>` can't load relative `/uploads` paths). `customersApi.list()/byId()` normalize it, tolerating several possible backend field names.
- `Avatar` now renders the image when present, falls back to initials when there's **no image OR the image genuinely fails to load** (`onError`), and **resets on `uri` change** so switching customers never shows a stale photo. Wired at customer detail, customer list rows, and the New-Booking customer selector.

**Honest status:** a real customer photo requires a backend feature that doesn't exist (image column + upload/storage + return). Adding a dead column with no upload path would change nothing visible and carries prod-migration risk (per repo policy, prod migrations are raw-psql only), so it was **not** done. **NOT marked fixed** — Rashid has no stored image to show; recommend a scoped "customer photo upload" feature if the product wants real customer photos.

---

## 2 — Home upcoming bookings (P0) — pending_payment was excluded

**Root cause (MOBILE):** vc12's `useUpcomingAppointments` fetched only `status=confirmed`+`pending`, and `selectUpcoming` kept only those two. Rashid Kazi's booking is **`pending_payment`** (a paid service on a ~15-min payment hold — a real value of the `bookingStatusEnum`), so it was fetched by neither query and dropped from "Up next", while the Activity feed (unfiltered window) still showed it: "Rashid Kazi · pending_payment · in 15h".

**Canonical lifecycle confirmed** (`db/schema.ts bookingStatusEnum`, 8 values): pending, confirmed, **pending_payment**, payment_failed, cancelled, completed, no_show, refunded. **Upcoming = {confirmed, pending, pending_payment}**; excluded = cancelled, completed, no_show, payment_failed, refunded (terminal).

**Fix:**
- `selectUpcoming` (`mobile/src/lib/upcoming.ts`) upcoming set → adds `pending_payment`.
- `useUpcomingAppointments` adds a **third** `status=pending_payment` query (merged; `nowMs`/refetch/loading/error all include it).
- `BookingStatus` type (`mobile/src/api/appointments.ts`) now mirrors the DB enum exactly (added pending_payment/payment_failed/refunded; removed the non-existent "rescheduled"); `AppointmentRow` status maps updated for all 8.
- Backend `app/api/bookings/route.ts validStatuses` now lists the full enum so `?status=pending_payment` is a **true server-side filter** (mobile previously relied on an unfiltered page being re-filtered client-side — fine for SMB, unreliable at scale). The mobile fix surfaces the booking against the current prod backend too (client re-filter); the deploy makes it robust.
- Home & Appointments stay consistent (same hook/selector). Refresh after create/confirm/reschedule/cancel/payment-settle via mutation invalidation + AppState-foreground + focus refetch + pull-to-refresh.

---

## 3 — Calendar month navigation (P0)

**Root cause:** the month label + chevrons lived only in the page header (small, easy to miss); the grid had no header and there was **no Today control**. **Fix:** `MonthView` now renders a clear in-grid month header — `‹  June 2026  ›` with a **Today** shortcut (Hermes-safe `monthLabel`/`isSameMonth`, not `toLocaleString`). Free browsing of **any** past/future month (the general Calendar is NOT clamped to the service booking horizon — that horizon applies only when picking a service slot in New Booking). The page header is simplified to avoid a duplicate month label. Selected-date + that day's bookings already worked.

---

## 4 — New Booking date picker (P0) + Calendar day → booking handoff

**The full `MonthCalendar` is already mounted** in `quick-create.tsx` (month/year header, prev/next, today, full grid, horizon-aware) — the screenshot's old 14-day strip was a **stale build**; no strip component exists in the code (only a stale header comment, now fixed). Added the **Calendar → New Booking date handoff**: the Calendar FAB passes `?date=YYYY-MM-DD` (Hermes-safe local date), and quick-create pre-selects it via a pure, clamped `parseInitialDate(param, today, max)` (past→today, beyond-horizon→max, garbage/impossible→today), one-shot so it never fights user taps. A source-level regression test asserts MonthCalendar is mounted and no strip remnant exists.

---

## 5 — UI polish (focused)

- **EmptyState**: vertical padding 4xl→2xl + smaller icon — empty cards no longer oversized (Home/Calendar/New Booking).
- **FAB overlap**: `ScreenContainer` now reserves bottom clearance (120dp) whenever a `floatingOverlay` (FAB) is present — fixes overlap on Home/Calendar/Customers/Appointments centrally; Home's manual double-spacer removed.
- **"Appointments" truncation**: Home quick-action label now wraps to 2 lines instead of "Appointme…".
- **Customer detail**: real-image-ready avatar; stats grid padding loosened (xs→sm). Edit/Archive live in the top bar (no bottom CTA → no safe-area issue).
- Touch targets: per-row service share + nav buttons use hitSlop ≥8 (≥44dp effective).

## FINAL REPORT
```
PROFILE IMAGE ROOT CAUSE:  No customer image field exists in the product (DB customers table has none; both
                           customer APIs return none; WEB also shows initials). "RK" initials are correct.
PROFILE IMAGE FIX:         Mobile made image-capable + forward-compatible (Customer.imageUrl absolutized; Avatar
                           uri + onError→initials + reset-on-switch; wired at detail/list/selector). A real photo
                           needs a backend customer-photo feature (does not exist) — flagged, not built.
RASHID IMAGE:              No stored image exists → initials (correct). NOT marked fixed (no photo to show).
UPCOMING ROOT CAUSE:       Mobile upcoming fetched/kept only confirmed+pending; pending_payment was dropped.
PENDING_PAYMENT STATUS:    Real bookingStatusEnum value (paid booking on a payment hold) → IS upcoming.
UPCOMING FIX:              upcoming = {confirmed,pending,pending_payment}; 3rd status query; BookingStatus type
                           = DB enum; backend validStatuses includes full enum (true server-side filter).
NEXT-DAY BOOKING:          The ~15h-out pending_payment booking now appears in Home Up Next (regression-tested).
HOME REFRESH:              refetchOnMount + focus refetch + AppState-foreground invalidation + mutation invalidation
                           + pull-to-refresh; nowMs advances on each refresh.
CALENDAR ROOT CAUSE:       Month label/nav only in page header; no in-grid header, no Today.
MONTH HEADER:              In-grid "‹ Month YYYY ›" (Hermes-safe monthLabel).
PREVIOUS MONTH / NEXT MONTH / TODAY: all present in the grid header; free browsing, no horizon clamp.
PAST MONTHS / FUTURE MONTHS: both browsable on the general Calendar.
NEW BOOKING DATE PICKER:   MonthCalendar (already mounted; screenshot was a stale build).
OLD DATE STRIP:            Does not exist in code (only a stale comment, fixed). Regression test guards it.
SELECTED DATE HANDOFF:     Calendar FAB → /quick-create?date=YYYY-MM-DD → parseInitialDate (clamped, one-shot).
HOME UI:                   smaller empty-state; FAB clearance; "Appointments" no longer truncated; tail spacer trimmed.
CALENDAR UI:               clear month header + Today; consistent grid; FAB clearance.
NEW BOOKING UI:            full month calendar; intake step; no clipped strip.
CUSTOMER DETAIL UI:        image-ready avatar; looser stats padding; top-bar edit/archive.
TESTS:                     +8 (upcoming pending_payment regression; parseInitialDate ×3; new-booking-picker ×3;
                           customer-image url case). 58/58 mobile total.
MOBILE TYPECHECK:          PASS
BACKEND TYPECHECK:         PASS
EXPO DOCTOR:               18/18
ANDROID EXPORT:            OK
IOS EXPORT:                OK
ANDROID PREBUILD:          OK (--clean)
WEB TESTS:                 733/733 backend suite (incl. 9 bookings tests) — no regression
WEB BUILD:                 OK
ANDROID VERSION CODE:      13
IOS BUILD NUMBER:          9
COMMIT:                    a67f6ec
PUSHED:                    YES → origin/main
BACKEND DEPLOYED:          DONE + verified — validStatuses live on prod (35.83.95.42, HEAD 8349572);
                           pre-deploy PG backup OK (1.87 MB, 619 lines); build once + PM2 restart + save;
                           /api/health 200 (edge + local); /api/bookings 401 (auth-gated, live). No migration.
CODEMAGIC BUILD:           OPERATOR ACTION — start android-preview on main (versionCode 13)
DEVICE QA:                 PENDING — physical Android device
P0 ISSUES:                 Upcoming + Calendar + New-Booking fixed in code (device-QA gated). Profile image NOT
                           fixed (missing backend feature; initials are correct).
P1 ISSUES:                 UI polish applied (focused).
READY FOR NEXT PREVIEW BUILD: YES (mobile); backend deploy for the validStatuses robustness improvement.
```

Per the task: Upcoming is NOT marked fully resolved until the next-day booking appears on the installed APK; Calendar is NOT resolved until the device browses prev/future months + creates a booking for a selected future-month date; Profile Image is NOT marked fixed (no stored customer image exists to show).

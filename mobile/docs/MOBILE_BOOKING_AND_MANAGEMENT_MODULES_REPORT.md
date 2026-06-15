# ZentroMeet Mobile — Booking Availability + Management Modules Report

**Date:** 2026-06-15 · **Mobile:** Expo SDK 52 / RN 0.76.9 · **Backend:** one **additive, web-compatible** change to `/api/slots` (see "Slot display contract" below — requires deploy)
**Scope:** New Booking availability + month navigation; Departments / Services / Locations / Working Hours modules; **P0 fix — out-of-hours slot display + missing logo (versionCode 10).**
**Key rule honored:** the server is authoritative for availability + all business rules — mobile reuses `/api/slots`, `/api/bookings`, and the existing CRUD routes; **no business logic was reimplemented on the device, no schema changes, no destructive operations.**

---

## New Booking — root cause

The mobile wiring was already correct end-to-end: `quick-create.tsx` → `appointmentsApi.slots()` → `GET /api/slots?serviceId=&staffUserId=any&date=&timezone=` (union mode, Bearer-auth) → `getAvailableSlots()`. Errors render as a distinct error card, so **"No openings" was a genuine empty result**, caused by:

1. **Service has no assigned staff** → `app/api/slots/route.ts` returns `{slots:[]}` (eligible_staff=0).
2. **No working hours for that weekday** → `lib/availability.ts` returns `[]` when the staff has no per-staff `availability` rule, no override, and the tenant default workspace-hours is unset.

Compounded by two real mobile defects:
3. **14-day hard-coded date strip** (`DATE_STRIP_DAYS=14`) — physically could not reach availability beyond ~2 weeks.
4. **Hermes timezone bug** — `isoDateInZone` used `Intl.DateTimeFormat({timeZone})`, which Hermes ignores; it fell back to `toISOString()` (UTC), sending the **previous calendar day** for operators east of UTC → fetched a wrong/closed day.

**This is a data/config gap surfaced as a dead-end UI, plus the date-range + timezone bugs.** The fix is mobile-side UX (navigation + clarity) + the timezone correction, and giving operators the **Working Hours** + **Services** modules to fix the underlying config.

## New Booking — fixes (`mobile/app/quick-create.tsx`, `src/lib/dates.ts`, `src/components/ui/MonthCalendar.tsx`)

- **Time slots / timezone:** date is now sent via `isoDateLocal()` — the picked calendar day's LOCAL components, literally (Hermes-safe; no Intl, no UTC shift). Backend interprets it in the tenant/staff timezone. The slot grid shows a count + the timezone (`N TIMES · America/New_York`). All rule enforcement (working hours, buffers, min-notice, horizon, conflicts) stays 100% server-side; mobile never filters slots.
- **Month selector + horizon:** new `MonthCalendar` — full month grid, prev/next-month chevrons, tap-Today, disabled past days, disabled days beyond `service.maxAdvanceDays` (server truth; `maxAdvanceDays` widened into the `Service` type). Open-ended forward nav when no horizon is set. Replaces the 14-day strip.
- **No-availability taxonomy:** loading (shimmer) · API error → error card **+ Retry** (offline-safe) · empty → "No openings on {weekday, date}" with a **"Find next opening"** scan (probes forward up to 60 days / the horizon, one-tap jump to the first open day) · if the scan is dry → guidance that the service may have no bookable staff/hours → set them in **Settings → Working Hours**.
- **Slot-conflict safety:** a 409/422 at confirm (slot raced by another booker) clears the selection, refetches availability, and prompts "That time was just taken — please pick another." Server remains authoritative; no conflicting insert is forced.

---

## P0 — Out-of-hours slots + missing logo (versionCode 10)

**Out-of-hours slots (e.g. ~2:00 AM for 9 AM–6 PM hours) — root cause = MOBILE display, not backend generation.** `lib/availability.ts` correctly clamps each slot to the staff working window in the staff timezone and emits UTC instants (verified by reading the engine + 733/733 backend tests). Mobile was formatting those UTC instants with the **device** clock, so a 9 AM slot read as ~1–2 AM — worst for Google-OAuth users defaulting to `UTC`.

**Slot display contract (additive backend change — `app/api/slots/route.ts` + new `lib/slots-display.ts`).** `/api/slots` now also returns an authoritative `timezone` and `display[]` of `{ start, label }`, where `label` ("9:00 AM") is formatted **once, server-side**, in the request/tenant timezone (`formatInTimeZone`). The original `slots: string[]` is unchanged, so **web and public booking are untouched** (they ignore the new fields). Mobile (New Booking + Reschedule) renders `display[].label` and books `display[].start` (the raw instant) — **zero on-device timezone math** (Hermes can't format IANA zones reliably). Valid in-hours slots (3:15 PM) still show; conflict/buffer/min-notice/horizon untouched; the defect is fixed at the source, not hidden by UI filtering. Covered by `tests/slots-display.test.ts` (9 AM→"9:00 AM" not 2 AM, device-tz-vs-authoritative-tz, east/west-of-UTC, DST). **Requires a backend deploy.**

**Missing logo in the installed APK.** `Logo.tsx` painted the mark via `react-native-svg`, which is unreliable in release Hermes. Now a **bundled raster** `mobile/assets/logo-mark.png` (512×512, rasterized from the existing `public/zentromeet-mark.svg` brand asset — no new design) loaded with `require()` + `<Image>` (bulletproof in release); wordmark text + tenant-logo override (remote `<Image>` `onError` → bundled fallback) preserved.

---

## Management modules (Settings → Management, role-gated)

A new **Management** group in Settings (admin/manager see Departments/Services/Locations/Working Hours; staff see Working Hours for their own schedule). Writes require admin/manager **on the backend**; the UI gating is UX-only. All endpoints are tenant-scoped server-side (no `tenantId` ever sent).

### Departments (`/settings/management/departments`) — list + create
Reuses `GET/POST /api/departments`. List (name, color, staff/service counts, assigned-service chips), search, managerial create modal (name, brand-color chip, description), read-only detail. **Backend gap:** no `app/api/departments/[id]` route exists → **edit/delete are not available** (flagged below); the screen says so and points to web.

### Services (`/settings/management/services` + `/[id]`) — full CRUD
Reuses `GET/POST /api/services`, `PATCH/DELETE /api/services/:id`. List with Active/Paused filter, search, per-row activate/deactivate toggle, managerial create FAB. Detail/edit: name, description, duration, price (dollars↔cents), buffers, color, Active toggle, delete-with-confirm (backend soft-archives when bookings exist). The **no-staff-bookability rule** is surfaced; create auto-links the creator as staff server-side; activation errors (e.g., plan cap) show the server message verbatim. (`minNoticeMinutes`/`maxAdvanceDays` have no backend write path — shown read-only "managed on web".)

### Locations (`/settings/management/locations` + `/[id]`) — full CRUD
Reuses `GET/POST /api/locations`, `PATCH/DELETE /api/locations/:id`. List (type pill, address, staff count), managerial create. Detail/edit: name, `locationType` (segmented, enum read from the route — not invented), address, phone, email, timezone, notes, Active. **`isSystem` locations can't be deleted** (button hidden + backend 409 surfaced). No private meeting credentials exposed.

### Working Hours (`/settings/management/working-hours`) — full
Reuses `GET/PUT /api/availability`. Weekly editor (per-day enable + start/end HH:MM, validated end>start, "copy to all", DST-safe literal HH:MM strings, never device Date math). Managerial roles get a staff picker (self default; staff = self only). Shows the profile timezone. **On save, invalidates `["availability"]`, `["appointments"]`, and `["slots"]` so New Booking reflects new hours immediately.** (Added `apiPut` to `src/api/client.ts` — the client lacked PUT.)

---

## Backend changes
**One additive, web-compatible change:** `/api/slots` returns extra `timezone` + `display[]` fields (new `lib/slots-display.ts`); the existing `slots: string[]` is preserved so web/public consumers are unaffected. **No schema change, no migration, no destructive op. Requires a production deploy.** Every management module still reuses an existing production route unchanged. **One backend gap flagged for a fast-follow:** add `app/api/departments/[id]/route.ts` (PATCH/DELETE, `requireRole(["admin","manager"])`, null-out `services.departmentId`/`users.departmentId` on delete) to unlock mobile Departments edit/delete. Until then, Departments is list + create only.

## Security / tenant isolation
- All reads `requireUser()`; all writes `requireRole(["admin","manager"])` (services/locations/departments/workspace-hours). Working-hours PUT allows self for any role; managers target others via `?userId=`.
- Tenant derived from the session everywhere; cross-tenant ids 404. The `staffUserId="any"` slots path additionally asserts `session.tenantId === service.tenantId`.
- New API clients use the shared `apiGet/apiPost/apiPatch/apiPut/apiDelete` (ApiError shape) so all screens get consistent error/offline handling.

## Tests
- `mobile/tests/dates.test.ts` (7): `isoDateLocal` (no UTC/Intl shift), month/day/year-boundary navigation, `monthMatrix` 6×7 + focal-month flags, `weekStartsOn`, Hermes-safe labels.
- Existing mobile tests still green (`url`, `safeInit`, `polyfills`). Backend `calendar-oauth-mobile` + full backend suite unaffected (no backend change).
- Availability-engine rule tests (closed/no-staff/buffer/min-notice/DST/fully-booked) live server-side and are covered by the backend suite (**733/733**, incl. new `tests/slots-display.test.ts`); mobile does not reimplement them.

## Builds / validation
- `tsc --noEmit` mobile: clean (incl. all new module files). expo-doctor / android+iOS export / android prebuild: see final response.

## Remaining gaps (deferred / flagged)
- **Departments edit/delete** — needs the backend `[id]` route (flagged above).
- **Service `minNoticeMinutes`/`maxAdvanceDays` write path** — backend schemas omit them (read-only on mobile).
- **Service staff-assignment editor, location logo upload, availability breaks/overrides/holidays, per-service & per-location hours, tenant default workspace-hours editor** — scoped out this pass (single weekly window per day on mobile; advanced config stays on web).
- **Device QA** — operator step; New Booking time-slot success is NOT marked fixed until the installed app shows and books a real slot. The **versionCode-10** P0s (logo visible + only in-hours slots + a real booking) are NOT marked resolved until verified on the installed APK against the deployed backend.

# P0 — Appointment time displays 7 hours early on mobile

**Status:** FIX APPLIED + LOCALLY VALIDATED. **NOT marked resolved** until the installed
mobile app and the web app show the **same** time on a physical device (per the rule).
**Release builds + store submissions remain FROZEN** until that device check passes.

**Android versionCode:** 14 → **15** · **iOS buildNumber:** 10 → **11**
**Backend:** additive viewer-tz display labels on the booking endpoints — **deploy required**
(Hermes cannot format an arbitrary IANA zone on-device; the label must be built server-side).

---

## 1. Symptom (reported)

An appointment created for **May 16 2026, 5:00 PM** shows:
- **Web dashboard:** `5:00 PM` ✅ (correct — the baseline)
- **Mobile app:** `10:00 AM` ❌ — **exactly 7 hours early**

7 hours = the UTC offset of US Pacific Daylight Time (UTC−7). That number is the tell.

## 2. The instant is correct — this was never a storage bug

Traced the actual stored value (no assumptions):

- `bookings.start_at` column type = **`timestamp with time zone`**. Postgres stores it as a
  UTC instant; the driver serializes it back through `Date.toISOString()` → an **ISO-8601 `…Z`**
  string. The stored instant is correct and unambiguous.
- Prod evidence (masked): a booking stored as `2026-06-01T16:15:00Z` is `9:15 AM` in the staff
  zone `America/Los_Angeles` — i.e. the instant is right; only the *rendering* was wrong.
- The reported tenant (`af66b982…`) had **staff/tenant timezone = `UTC`**. So its "5:00 PM"
  appointment is stored as **`17:00Z`**.

## 3. Root cause — every formatting step traced

The wrong number is produced **entirely on the mobile client**, at display time:

| Step | Where | Behaviour |
|---|---|---|
| Serialize instant | backend → JSON | `17:00Z` (correct ISO-Z) |
| Mobile receives | `src/api/appointments.ts` | keeps the ISO string verbatim (correct) |
| Mobile formats | `src/lib/format.ts` `formatTime()` | `new Date(iso).getHours()` → **device-local hour** |
| Render | AppointmentRow / detail / calendar / home | prints the device-local hour |

`getHours()` returns the hour **in the device's local zone**. On a US-Pacific device (UTC−7),
`new Date("2026-05-16T17:00:00Z").getHours()` = `10`. So a UTC-tenant **5 PM** renders as
**10 AM** — the exact 7-hour error. (A device set to UTC would have shown 5 PM by luck; the bug
surfaces whenever device tz ≠ the tz the appointment should display in.)

**Why not just use `Intl.DateTimeFormat({ timeZone })` on mobile?** Because **Hermes (Expo SDK 52 /
RN 0.76.9) does not honour the `timeZone` option** — it silently formats in device-local. This is
the same engine limitation already documented for the slots picker (`isoDateLocal`) and worked
around server-side in `lib/slots-display.ts`. On-device `date-fns-tz formatInTimeZone` is likewise
not viable. **The correct, proven pattern is to format the label server-side.**

## 4. The canonical timezone contract (one rule, all surfaces)

1. **The stored instant is authoritative** — ISO-8601 UTC (`…Z`). It is never mutated, re-parsed
   ambiguously, double-converted, or reconstructed from a formatted string.
2. **The authoritative DISPLAY zone is the signed-in VIEWER's `user.timezone`** — the *same* rule
   the web dashboard uses (`app/dashboard/appointments/page.tsx` → `formatInTimeZone(startAt,
   viewerTz, …)`). Not the device zone; not blindly the staff zone. This is why web shows 5 PM and
   mobile must too.
3. **The label is formatted exactly ONCE, server-side**, with `date-fns-tz` (a backend dep), and
   sent alongside the raw instant. Mobile renders the label **verbatim** and keeps the raw ISO
   instant for sorting / mutations (reschedule, cancel).
4. **No hardcoded ±7 / ±N correction.** DST correctness is preserved because `date-fns-tz` resolves
   the offset from the IANA zone at that instant (PDT vs PST etc.).

### Backend — additive labels (no schema change, no instant change)

New helper `lib/appointment-labels.ts` (mirrors `lib/slots-display.ts`):

```ts
buildBookingLabels(startIso, endIso, viewerTz) → {
  timezone, startLabel /* "5:00 PM" */, endLabel, startDayLabel /* "Saturday, May 16" */, tzAbbrev /* "PDT" */
}
```

Invalid/empty tz → falls back to `UTC` and never throws.

Attached on every appointment-bearing endpoint, keyed to the **signed-in caller's** timezone:

| Endpoint | Viewer tz source |
|---|---|
| `GET /api/bookings` (list) | session user's `timezone` |
| `POST /api/bookings` (create) | session user `?? staff ?? UTC` |
| `GET /api/bookings/:id` (detail) | `requireUser().timezone` |
| `POST /api/bookings/:id/reschedule` | `requireUser().timezone` |
| `GET /api/customers/:id` (history) | `requireUser().timezone` |

### Mobile — one formatter chokepoint

New `mobile/src/lib/appointmentTime.ts` — **pure, no `Intl` timeZone, no date-fns**:
- `apptTime` / `apptEndTime` / `apptTimeRange` / `apptDay` / `apptTimeWithDay` render the server
  label verbatim.
- **Fallback** when a label is absent (pre-deploy backend, or an optimistic locally-minted row
  before refetch): a deterministic **UTC wall-clock slice** of the ISO string — **never**
  `getHours()`. For a UTC-tenant viewer this already matches web *before* the backend deploy; every
  other viewer gets the exact label once the labeled response arrives.
- `apptStartMinutes` derives the calendar lane position from the **same** label, so a booking's
  vertical position matches its printed time (both viewer-tz, never device-local).

The four device-local formatters in `mobile/src/lib/format.ts` (`formatTime`, `formatTimeRange`,
`formatDateLong`) are **no longer called on any appointment surface**; non-appointment callers
(e.g. local-midnight picker dates, which are correctly device-local) keep using them.

## 5. Every appointment surface rerouted to the contract

| Surface | File | Change |
|---|---|---|
| Home — "Next …" team chip | `app/(tabs)/index.tsx` | `apptTime` + carries `startLabel` |
| Calendar — week lane + label | `app/(tabs)/calendar.tsx` | `apptStartMinutes` + `apptTime` (was `getHours`/`toLocaleTimeString`) |
| Appointment list row | `src/components/ui/AppointmentRow.tsx` | `apptTime` / `apptTimeWithDay` (deleted local formatters) |
| Appointment detail | `app/appointments/[id]/index.tsx` | `apptDay` + `apptTimeRange` |
| Reschedule (current-time line) | `app/appointments/[id]/reschedule.tsx` | `apptDay` + `apptTimeRange` (picker dates stay device-local) |
| Customer activity / history | `app/customers/[id]/index.tsx` | passes `startLabel`/`endLabel`/`startDayLabel` through |
| Wire types | `src/api/appointments.ts`, `src/api/customers.ts` | label fields added + passed through `normalize()` |

**Other surfaces audited — no change needed:**
- **Push notifications:** payload uses **relative** time ("in 2h"), which is tz-agnostic and
  already correct. The detail screen a push opens is fixed above.
- **New-booking confirmation / share / public booking / emails / reminders / calendar feeds:**
  rendered by the **web/server** path (already correct — the baseline) and untouched.
- **Cache:** raw instants are cached; the display is computed at render, so an old cache simply
  uses the UTC-slice fallback (no 7-hour error) and upgrades to the exact label on next fetch. No
  migration needed.

## 6. Tests (regression)

- **Backend** `tests/appointment-labels.test.ts` (5): the exact defect (`17:00Z` UTC viewer →
  `5:00 PM`, **not** `10:00 AM`); 5 PM Pacific == `00:00Z` next day → `5:00 PM`, `Saturday, May 16`,
  `PDT`; full tz matrix (LA/Denver/Chicago/NY/London/Kolkata/Sydney incl. date rollover); DST
  summer-PDT vs winter-PST; invalid/empty tz → UTC fallback, no throw.
- **Mobile** `tests/appointment-time.test.ts` (13): server label rendered verbatim; en-dash range;
  UTC-slice fallback = `5:00 PM` (never `10:00 AM`) independent of host tz; 12-hour boundaries;
  fail-safe on garbage; `apptStartMinutes` parses minutes-of-day from the label.

## 7. Validation gates — all green (this commit)

```
BACKEND tsc:        PASS (0 errors)
BACKEND tests:      PASS — 747/747 (incl. 5 new appointment-labels)
WEB build:          PASS (next build)
MOBILE tsc:         PASS (0 errors)
MOBILE tests:       PASS — 75/75 (incl. 13 new appointment-time)
EXPO doctor:        PASS (18/18)
EXPO export:        PASS (android + ios bundles)
EXPO prebuild:      PASS (android --clean; generated dir reverted, repo stays managed)
ANDROID versionCode: 14 → 15
IOS buildNumber:     10 → 11
```

## 8. Deploy + release gating

- **Backend deploy: REQUIRED** — the additive labels must be live for non-UTC viewers to get the
  exact time. (Purely additive: no schema change, no instant change, no behavior change for web /
  public booking / emails / reminders / calendar.) Deploy on explicit authorization, with a
  pre-deploy PG backup and a post-deploy health check.
- **Codemagic `android-preview`: OPERATOR ACTION** — triggered only **after** validation, by the
  owner (no Codemagic API/UI access here).
- **iOS / TestFlight / production AAB: NOT triggered** — frozen until the device check passes.
- **Do NOT mark this P0 resolved** until the installed mobile app shows the **same** time as web on
  a physical device.
```
P0 STATUS:                FIX APPLIED + LOCALLY VALIDATED; awaiting physical-device confirmation
ROOT CAUSE:               mobile formatTime used device-local getHours() on a UTC instant
                          (Hermes ignores Intl timeZone) -> UTC-tenant 5 PM showed as 10 AM on a
                          Pacific device (exactly the -7h PDT offset)
FIX:                      format the label ONCE server-side in the signed-in VIEWER's tz (web's
                          rule); mobile renders it verbatim, UTC-slice fallback, never getHours
BACKEND DEPLOY:           REQUIRED (additive viewer-tz labels) — pending authorization
CODEMAGIC BUILD:          OPERATOR ACTION — android-preview on main (versionCode 15), after deploy
IOS / TESTFLIGHT / AAB:   FROZEN — not triggered
DEVICE QA:                PENDING — physical device must match web
```

# ZentroMeet Mobile — Home Upcoming, Official Logo & Booking-Link Sharing

**Date:** 2026-06-15 · **Mobile:** Expo SDK 52 / RN 0.76.9 · **versionCode 12 / iOS build 8** · **Backend: NO changes (all fixes mobile-only).**

Fixes four functional issues in the Android preview: (1) Home shows no upcoming bookings, (2) the official ZentroMeet logo doesn't appear, (3) services have no way to open/copy/share their public booking page, (4) the main Share action wrongly navigated to Settings.

---

## 1 — Home upcoming bookings (P0)

**Root cause (MOBILE):** the backend `GET /api/bookings` orders **`desc(startAt)`** over a fixed 90-day floor and accepts only `status`/`cursor`/`limit` (no `from`/`to`, no ascending). Home fetched `limit:200` with **no status filter** and then applied a **client-side `to = +32 days` clip** on that newest-200 page. Result: cancelled/completed rows consumed the page and the `+32d` clip discarded the rest, so the "Up next" filter (`confirmed||pending && startAt>=now`) legitimately came up empty even with real upcoming bookings. (The Appointments tab works because it passes no `from`/`to`.)

**Fix (`mobile/src/hooks/useAppointments.ts` `useUpcomingAppointments` + `mobile/src/lib/upcoming.ts`):** a dedicated, **status-filtered** upcoming query — `status=confirmed` (limit 200) + `status=pending` (limit 100), merged — so the page isn't diluted by cancelled/completed/no_show. Pure `selectUpcoming(rows, nowMs, count)` then keeps `confirmed||pending` with `startAt>=now` (epoch comparison → timezone-agnostic), sorts **ascending** (soonest first), slices to 3. The `+32d` clip is gone, so a booking weeks out still shows. `refetchOnMount:"always"` + pull-to-refresh + the existing create/cancel/status mutation invalidations keep Home fresh after booking/confirm/reschedule/cancel.

**Documented edge:** for a tenant with **>200 future confirmed** bookings, the desc order could still page out the soonest — the robust fix at that scale is a backend `asc`/`from` param (out of scope; no backend change). Realistic SMB tenants are well under that.

**Home UX:** "Up next" decoupled from the KPI window; the empty state now offers **New booking** + **Share link** actions; a **View all → Appointments** link sits in the section header. Loading skeleton / error+Retry / empty states all driven by the upcoming query.

---

## 2 — Official ZentroMeet logo (P0)

**The exact attached badge is bundled** at `mobile/assets/zentromeet-logo.png` (1417×1417, transparent, **byte-identical** to the attachment — extracted from the session attachment, not redrawn/approximated/regenerated). `mobile/src/components/ui/Logo.tsx` (also exported as `ZentroMeetLogo`) now renders that badge image via `require()` + `<Image resizeMode="contain">` with explicit non-zero width/height (never collapses), `accessibilityLabel="ZentroMeet"`. The badge already contains the wordmark + tagline, so the previous **generated RN-text wordmark was removed** (it was exactly the "text recreation" to avoid). The old `logo-mark.png` (a different Z mark) is deleted.

**Tenant logo stays a SEPARATE concept:** `tenantLogoUrl` still overrides on tenant-branded surfaces and falls back to the bundled platform badge on image error — platform surfaces never pass it and never depend on a remote URL.

**Mounted on:** Login (`login.tsx`, size 108), Boot/loading (`_layout.tsx` BootLoading, 84), Settings footer/About (`(tabs)/settings.tsx`, 64), and the **Home header** hero (`(tabs)/index.tsx`, 26). A build-time test (`tests/logo-asset.test.ts`) asserts the asset resolves, is a valid PNG, and is the exact attached size; expo export/prebuild prove Metro mounts it.

---

## 3 & 4 — Booking-link sharing + fixing Share→Settings (P0/P1)

**Share root cause:** the Home "Share" quick action was a placeholder — `onPress={() => router.push("/(tabs)/settings")}` — and Settings has no link affordance. **Now → `router.push("/share")`.**

**Canonical links, built locally from authoritative slugs (no backend change, no invented URLs, no internal IDs/tokens):** `mobile/src/lib/bookingLinks.ts` builds `{apiBaseUrl}/u/{tenantSlug}` (workspace page, lists active services) and `{apiBaseUrl}/u/{tenantSlug}/{serviceSlug}` (direct service). There is no user/staff slug and the optional `?staff={userId}` is deliberately never added, so no UUID leaks. `apiBaseUrl` (`EXPO_PUBLIC_API_BASE_URL`, default `https://app.zentromeet.com`) is the same origin that serves `/u/[slug]`.

**Share Links modal (`mobile/app/share.tsx`, registered as a modal in `_layout.tsx`):**
- **Your booking page** — tenant name + canonical URL, with Copy / Share / Open / QR.
- **Direct service links** — each **active, slugged** service (`useServices().data.active`, never paused/private) with its canonical URL + the same actions.
- **Missing-public-profile state** — if the workspace has no slug **or** `tenant.active === false`, a focused setup card ("finish setup on the web dashboard", opens the dashboard) and **no dead link** — never routes to Settings.

**Reusable `LinkShareCard`** (Copy via `expo-clipboard`, **native Share** via RN `Share` with a double-tap guard, **Open** via `expo-web-browser`, **QR** via `react-native-qrcode-svg` rendering locally on the bundled `react-native-svg` — offline, no third-party call, encodes ONLY the canonical URL). Inline "Link copied" feedback.

**Per-service sharing (Phase 7):** the service **detail** screen shows a "Public booking page" `LinkShareCard` for active+slugged services; the services **list** shows a per-row share icon (any signed-in user, active+public services only). Both reuse the canonical builder + share helpers.

**Security / isolation:** links built only from the caller's own tenant slug + service slugs (tenant-scoped, auth-required endpoints); only active/public services are offered; inactive-tenant/no-slug → setup state, no link. The public pages themselves 404 inactive tenants and only render active services server-side (defense in depth). No tokens in any URL.

---

## Tests (`mobile/tests/`)
- `bookingLinks.test.ts` (6) — URL shape, trailing-slash normalization, **no internal IDs/tokens/?staff**, slug encoding, `hasSlug` guard.
- `upcoming.test.ts` (5) — today's-future included; cancelled/completed/no_show/past excluded; ascending sort + slice; **40-days-out still shows**; epoch boundary (==now included, now-1ms excluded); empty input.
- `logo-asset.test.ts` (3) — bundled badge exists, valid PNG, **byte-identical to the attachment**; old mark removed.
- Full mobile suite: **50/50** (was 36; +14 new).

## Validation
- MOBILE: `npm ci` (deps added: expo-clipboard, react-native-qrcode-svg, SDK-52-installed); `tsc` clean; 50/50 tests; expo-doctor; expo export android+iOS; expo prebuild android `--clean`.
- BACKEND/WEB (no changes — regression check): `tsc`; full suite; production build.

## FINAL REPORT
```
HOME UPCOMING ROOT CAUSE:  MOBILE — no status filter + client +32d clip on a desc(startAt) newest-200 page; cancelled/completed crowded out near-term, clip dropped the rest
HOME UPCOMING FIX:         dedicated status-filtered query (confirmed+pending) → selectUpcoming (>=now, ASC, slice 3); no clip; refetchOnMount+pull-to-refresh+mutation invalidation
UPCOMING API:              GET /api/bookings?status=confirmed|pending&limit= (existing; no backend change)
TIMEZONE:                  epoch comparison (Date.getTime() >= Date.now()) — tz-agnostic; UTC instants
HOME EMPTY STATE:          "No upcoming bookings" + New booking + Share link actions; View all → Appointments
OFFICIAL LOGO SOURCE:      the exact attached badge (byte-identical, extracted from the attachment — not redrawn)
LOGO ASSET PATH:           mobile/assets/zentromeet-logo.png (1417×1417, transparent)
LOGIN LOGO:                yes (login.tsx, size 108)
HOME LOGO:                 yes (Home hero header, size 26) + Boot (84) + Settings/About (64)
TENANT LOGO BEHAVIOR:      separate concept; tenantLogoUrl overrides on branded surfaces, falls back to bundled badge; platform surfaces never depend on a remote URL
SHARE ROOT CAUSE:          Home Share quick action pushed /(tabs)/settings (placeholder); Settings had no link UI
MAIN SHARE ACTION:         → /share modal (Share Links)
USER BOOKING URL:          {apiBaseUrl}/u/{tenantSlug}
SERVICE BOOKING URL:       {apiBaseUrl}/u/{tenantSlug}/{serviceSlug}
PRE-GENERATED LINK MODEL:  persistent slugs (tenant.slug + service.slug) already in the DB/profile; links derived, stable, never randomly regenerated
PUBLIC PROFILE SETUP:      missing slug / inactive tenant → focused setup state (open web dashboard); no dead link, no Settings redirect
COPY LINK:                 expo-clipboard + "Link copied" feedback
NATIVE SHARE:              RN Share.share (double-tap guarded)
OPEN PREVIEW:              expo-web-browser in-app browser
QR:                        react-native-qrcode-svg (local/offline, encodes canonical URL only; no token/PII)
CUSTOM DOMAIN:             not used by mobile (admin-only); canonical host always resolves
SERVICE SHARE:             service detail card + per-row share icon (active+slug+public only)
PRIVATE/INACTIVE SERVICE:  not shareable (sourced from .active + hasSlug guard)
ROLE PERMISSIONS:          share available to any signed-in user for public links; bookings visibility unchanged (server RBAC: staff own, managers tenant)
TENANT ISOLATION:          links from caller's own tenant slug + services only (tenant-scoped auth endpoints)
TESTS:                     +14 (bookingLinks 6, upcoming 5, logo-asset 3); 50/50 mobile total
MOBILE TYPECHECK:          PASS
BACKEND TYPECHECK:         PASS
EXPO DOCTOR:               18/18
ANDROID EXPORT:            OK
IOS EXPORT:                OK
ANDROID PREBUILD:          OK (--clean)
WEB TESTS:                 733/733 (backend suite; no backend change → no regression)
WEB BUILD:                 OK
ANDROID VERSION CODE:      12
IOS BUILD NUMBER:          8
COMMIT:                    f9c03d6
PUSHED:                    YES → origin/main
BACKEND DEPLOYED:          NOT REQUIRED (zero backend changes)
CODEMAGIC BUILD:           OPERATOR ACTION — start android-preview on main (versionCode 12)
DEVICE QA:                 PENDING — physical Android device
P0 ISSUES:                 Home upcoming, official logo, Share→links — NOT marked resolved until verified on the installed APK
P1 ISSUES:                 per-service sharing — same gate
READY FOR NEXT PREVIEW BUILD: PENDING (gate)
```

Per the task: NOT marked fixed until the installed APK shows upcoming appointments, the attached official badge is visible, and Share exposes working user + service booking URLs.

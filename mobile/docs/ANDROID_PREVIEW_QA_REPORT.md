# UPDATE 7 — versionCode 13 preview: pending_payment upcoming, calendar month nav, profile-image readiness, UI polish, 2026-06-15

**Android versionCode:** 13 · **iOS buildNumber:** 9 · **Backend:** one additive `validStatuses` line in `/api/bookings` (deploy). Full detail in [MOBILE_HOME_CALENDAR_PROFILE_UI_FIX_REPORT.md](MOBILE_HOME_CALENDAR_PROFILE_UI_FIX_REPORT.md).

1. **Home upcoming (pending_payment):** vc12's upcoming query kept only confirmed+pending, so a future **`pending_payment`** booking (a paid booking on a payment hold — a real `bookingStatusEnum` value) was dropped while Activity showed it. Fix: upcoming = {confirmed, pending, pending_payment}; 3rd status query; `BookingStatus` type now matches the DB enum; backend `validStatuses` includes the full enum (true server-side filter).
2. **Calendar month nav:** added a clear in-grid month header (`‹ Month YYYY ›` + **Today**, Hermes-safe), free past/future browsing (no service horizon on the general Calendar); page header simplified.
3. **New Booking:** already mounts the full `MonthCalendar` (the screenshot's 14-day strip was a **stale build** — no strip in code). Added Calendar→New-Booking date handoff (`?date=` → clamped `parseInitialDate`).
4. **Customer profile image:** ROOT CAUSE = **no customer image exists in the product** (DB has no column; both customer APIs return none; the WEB also shows initials) — "RK" initials is correct. Mobile made forward-compatible (image-capable Avatar with absolutize + onError→initials + reset-on-switch). **NOT marked fixed** — a real photo needs a backend customer-photo feature that doesn't exist (flagged).
5. **UI polish:** smaller empty-state cards; central FAB clearance (no overlap); "Appointments" label no longer truncated; calendar/customer spacing.

**Local gates (all green):** backend `tsc`; **733/733** backend tests (incl. 9 bookings tests); web build OK; mobile `tsc`; **58/58** mobile tests (+8: pending_payment regression, parseInitialDate ×3, new-booking-picker ×3, customer-image url); expo-doctor 18/18; export android+iOS; prebuild android `--clean`.

```
ANDROID VERSION CODE:     13
IOS BUILD NUMBER:         9
BACKEND DEPLOYED:         PENDING — additive validStatuses (no migration); needs deploy authorization
CODEMAGIC BUILD:          OPERATOR ACTION — start android-preview on main (versionCode 13)
DEVICE QA:                PENDING — physical Android device
PROFILE IMAGE:           NOT fixed (no stored customer image exists; initials correct + consistent with web)
UPCOMING / CALENDAR / NEW BOOKING: fixed in code; device-QA gated
READY FOR NEXT PREVIEW BUILD: YES (mobile); deploy validStatuses for server-side robustness
```

---

# UPDATE 6 — versionCode 12 preview: Home upcoming, official logo, booking-link sharing, 2026-06-15

**Android versionCode:** 12 · **iOS buildNumber:** 8 · **Backend: NO changes (all mobile-only).**
Full detail in [MOBILE_HOME_BRANDING_AND_SHARING_REPORT.md](MOBILE_HOME_BRANDING_AND_SHARING_REPORT.md). Fixes four issues:

1. **Home shows no upcoming bookings** (MOBILE root cause): the list endpoint is `desc(startAt)`, 90-day floor, `status`/`cursor`/`limit` only. Home fetched newest-200 with **no status filter** + a client `+32d` clip, so cancelled/completed crowded out near-term and the clip dropped the rest. **Fix:** a dedicated status-filtered upcoming query (`confirmed`+`pending`) → pure `selectUpcoming` (`>=now`, ASC, slice 3), no clip, `refetchOnMount:"always"` + pull-to-refresh + mutation invalidation. Empty state gains New-booking/Share actions + a View-all link.
2. **Official logo:** the **exact attached badge** is bundled byte-identically at `mobile/assets/zentromeet-logo.png` (1417×1417, transparent) and rendered by `Logo`/`ZentroMeetLogo` via `require()`+`<Image>` (explicit size, never collapses) on login/boot/Settings/Home. The generated RN-text wordmark + old `logo-mark.png` are removed. Tenant logo stays a separate override.
3. **Service sharing:** the Share modal lists every active service's link; the service detail + services-list rows expose a share action (active+public only).
4. **Share→Settings bug:** the Home Share quick action pushed `/(tabs)/settings`; now pushes **`/share`** — a Share Links modal showing the real workspace page `{base}/u/{tenantSlug}` + per-service `{base}/u/{tenantSlug}/{serviceSlug}` with Copy / native Share / Open / QR. No internal IDs/tokens, only active services, missing-slug/inactive-tenant → focused setup state (no dead link, no Settings redirect).

**Local gates (all green):** backend `tsc`; **733/733** backend tests (no backend change → no regression); web build OK; mobile `tsc`; **50/50** mobile tests (incl. new `bookingLinks` 6, `upcoming` 5, `logo-asset` 3 — the logo test asserts byte-identity to the attachment); expo-doctor 18/18; export android+iOS; prebuild android `--clean`. Deps added: `expo-clipboard`, `react-native-qrcode-svg` (SDK-52 installed).

```
ANDROID VERSION CODE:     12
IOS BUILD NUMBER:         8
BACKEND DEPLOYED:         NOT REQUIRED — zero backend/API changes (public booking endpoints already in prod)
CODEMAGIC BUILD:          OPERATOR ACTION — start android-preview on main (versionCode 12)
DEVICE QA:                PENDING — physical Android device
P0/P1:                    NOT resolved until the installed APK shows upcoming bookings, the official badge, and shares real working user + service links
READY FOR NEXT PREVIEW BUILD: YES (no deploy needed)
```

---

# UPDATE 5 — versionCode 11 preview: P0 service-template intake fields in New Booking, 2026-06-15

**Android versionCode:** 11 · **iOS buildNumber:** 7.
**Fixes the P0** where a tax/accounting service booked from mobile failed at
confirm with a backend error requiring a field (e.g. "Filing Status") that the
mobile screen never showed.

**Root cause = MOBILE, not backend.** A service can link an active intake form
(`services.intakeFormId` → `intakeForms.fields`); the booking POST validates the
configured fields and 400s if a required one is missing. The web booking flow
fetches the form and submits `intakeResponses`; **mobile never fetched, rendered,
or sent them**, so the server rejected the booking and the operator had no field
to fill. Confirmed by reading `app/api/bookings/route.ts` (intake gate),
`lib/intake.ts validateResponses` ("Missing required field: …"), and the mobile
`quick-create.tsx` / `appointments.ts` (no intake layer at all).

**Fix (mobile-only; reuses the existing system end to end — no new field model,
no backend change):**
- Fetch the service's render-ready form from the existing public endpoint
  `GET /api/public/services/{id}/intake-form` (returns `{form|null}`, fields
  canonicalized + ordered). New `mobile/src/lib/intake.ts` (pure types + client
  validator) + `mobile/src/api/intake.ts` (`intakeApi.getForm`).
- New dynamic **"Service details"** step in New Booking
  (`mobile/src/components/ui/IntakeFields.tsx`) renders all 12 canonical field
  types (short_text, long_text, email, phone, number, url, select, multi_select,
  radio, date, boolean, consent) in configured order, with required markers,
  help text, options, defaults, and per-field validation. The step only appears
  when the service has a form; Date/Time renumber contiguously; answers clear on
  service change and persist across date/time navigation.
- Submit adds `intakeResponses` (object keyed by `field.key`) to the **same**
  `POST /api/bookings`; only non-empty/valid answers are sent; the server
  re-validates (authoritative). Client validation mirrors the server and maps
  errors under each field ("Filing status is required"); the booking POST is
  blocked until valid.
- **Appointment detail** gains a read-only "Service details" card via
  `GET /api/bookings/{id}/intake-responses` (labeled, role-gated, historical-safe).
  Editing answers has no backend write path → read-only by design (documented).
- **Web + public booking, availability, OAuth, customer CRUD: untouched** — the
  diff is mobile-only (zero backend/web files changed).

**Adversarial review applied (FIX-FIRST → fixed):** (1) the `url` client check
relied on `new URL()` throwing, which is a no-op under Hermes → replaced with a
Hermes-safe `scheme://host` regex; (2) a `defaultValue` not in a select/radio/
multi_select's `options` would pass the client but 400 server-side → seeding now
drops off-options defaults, and the client validator gained option-membership
parity. (3) date stays strict `YYYY-MM-DD` (intentional data hygiene; documented).

**Local gates (all green):** backend `tsc`; **733/733** backend tests (no
backend change — proves no regression); web production build OK; mobile `tsc`;
**36/36** mobile tests (incl. new `tests/intake.test.ts`, 13 cases: required
Filing Status regression, number min/max, email/url/date, select/radio/
multi_select membership, consent, stale-answer drop, legacy-type canonicalize +
order, option-aware default seeding, appointment-detail formatting); expo-doctor
18/18; expo export android+iOS; expo prebuild android `--clean`.

```
ROOT CAUSE:               MOBILE never fetched/rendered/sent service intake fields (backend authoritative + correct)
CANONICAL FIELD MODEL:    intakeForms.fields JSONB (IntakeField) ← services.intakeFormId; answers in bookings.intakeResponses + intake_field_responses (server-owned)
SERVICE API:              GET /api/public/services/{id}/intake-form (existing, unauth) — no backend change
FIELD TYPES:              12 canonical (short_text,long_text,email,phone,number,url,select,multi_select,radio,date,boolean,consent)
DYNAMIC FORM:             new "Service details" step (IntakeFields.tsx); order/required/options/defaults/help/validation; clears on service change
SUBMISSION PAYLOAD:       intakeResponses object keyed by field.key on POST /api/bookings (non-empty only)
APPOINTMENT DETAIL:       read-only "Service details" card via GET /api/bookings/{id}/intake-responses
ANDROID VERSION CODE:     11
IOS BUILD NUMBER:         7
BACKEND DEPLOYED:         NOT REQUIRED — zero backend/API changes (endpoints already in production)
CODEMAGIC BUILD:          OPERATOR ACTION — start android-preview on main (versionCode 11)
DEVICE QA:                PENDING — physical Android device required
P0 ISSUES:                NOT marked resolved until the installed APK renders Filing Status and books a real service-specific appointment
READY FOR NEXT PREVIEW BUILD: YES (no deploy needed)
```

---

# UPDATE 4 — versionCode 10 preview: P0 logo + out-of-hours slots, 2026-06-15

**Android versionCode:** 10 · **iOS buildNumber:** 6.
**Fixes two P0 booking-integrity defects:**

1. **Missing logo in the installed APK.** Root cause: `Logo.tsx` rendered the
   brand mark via `react-native-svg`, which does not paint reliably in a release
   Hermes build (the very path the preview APK uses). **Fix:** the official
   ZentroMeet mark is now a **bundled raster** — `mobile/assets/logo-mark.png`
   (512×512, rasterized from the existing `public/zentromeet-mark.svg` brand
   asset via `sharp`, no new design) — loaded with `require()` + `<Image>`. A
   bundled `require()` asset is bulletproof in release. Wordmark text and the
   tenant-logo override (remote `<Image>` with `onError` → bundled fallback) are
   preserved. The mark now renders on login, the boot screen, and the Settings
   footer.

2. **Out-of-hours slots (e.g. ~2:00 AM for 9 AM–6 PM working hours).**
   **Root cause = MOBILE timezone display, NOT backend generation.** The backend
   (`lib/availability.ts`) correctly clamps slots to each staff's working window
   in the staff timezone and returns UTC instants; verified by reading the engine
   and by 733/733 backend tests. The mobile app was formatting those UTC instants
   with the **device** clock (`formatTime`), so a 9 AM slot rendered as ~1–2 AM —
   worst for Google-OAuth users whose timezone defaults to `UTC`.
   **Fix (server-authoritative, web-compatible):** `/api/slots` now returns, in
   addition to the unchanged `slots: string[]`, an authoritative `timezone` and a
   `display[]` of `{ start, label }` where `label` ("9:00 AM") is formatted ONCE
   server-side in the request/tenant timezone (new pure helper
   `lib/slots-display.ts`). Mobile (New Booking + Reschedule) renders
   `display[].label` and books `display[].start` (the raw instant) — it does **no**
   on-device timezone math (Hermes can't format IANA zones reliably). Valid
   in-hours slots (e.g. 3:15 PM) still show; conflict/buffer/min-notice/horizon
   behavior is untouched; **web and public booking are unchanged** (they ignore the
   additive fields). The defect was NOT papered over by UI-side filtering.

**Local gates (all green):** backend `tsc`; **733/733** backend tests (incl. new
`tests/slots-display.test.ts`: 9 AM labels as 9:00 AM not 2 AM, the device-tz-vs-
authoritative-tz bug, east/west-of-UTC, DST); web production build OK; mobile
`tsc`; **23/23** mobile tests; expo-doctor 18/18; expo export android+iOS; expo
prebuild android `--clean`.

```
LOGO ROOT CAUSE:          react-native-svg mark did not paint in release Hermes
LOGO FIX:                 bundled raster logo-mark.png (official mark) via require()+<Image>
SLOT ROOT CAUSE:          MOBILE display — UTC instants formatted in device tz (backend correct)
SLOT FIX:                 server returns authoritative timezone + display[] labels; mobile renders labels, books raw instants
ANDROID VERSION CODE:     10
IOS BUILD NUMBER:         6
BACKEND DEPLOY:           DONE + verified — commit 9038632 on prod (35.83.95.42); pre-deploy PG
                          backup OK (1.83 MB, 619 restore-list lines, 69 table-data); build once +
                          PM2 restart once + pm2 save; no drizzle-kit/schema change.
HEALTH:                   /api/health = 200 (edge https://app.zentromeet.com + local :3001)
SLOTS VERIFY:             /api/slots live on new build (route wired to buildSlotDisplay); deployed
                          runtime formats synthetic 9AM–6PM EST → first 9:00 AM, last 5:45 PM,
                          36 slots, ZERO pre-9AM/2AM-class labels (privacy-safe, no customer data)
CODEMAGIC BUILD:          OPERATOR ACTION — start `android-preview` on `main` in the Codemagic UI
                          (versionCode 10; app code == commit 9038632). Auto-trigger is `develop`
                          only and that branch does not exist; no API token available to trigger.
APK:                      PENDING (versionCode 10)
DEVICE QA:                PENDING — physical Android device required
READY FOR NEXT PREVIEW BUILD: YES — backend deployed; operator can build now
RESOLUTION:               NOT marked resolved until the installed APK shows the logo AND only
                          in-hours slots AND completes a real booking on the device
```

---

# UPDATE 3 — versionCode 8 preview (features + calendar OAuth), 2026-06-15

**Commit:** `2fca3a0` · **Android versionCode:** 8 · **iOS buildNumber:** 4.
**Adds:** ZentroMeet logo, profile-image URL normalization, full customer create/edit/archive, Google + Microsoft **mobile** calendar OAuth (secure signed-state handoff), OAuth deep-link routes, tenant-logo support.

**Backend:** deployed `2fca3a0` to production (35.83.95.42) + verified — PM2 online (no loop), nginx active, `/api/health` 200, `/api/auth/me` 401, new `…/connect/mobile` endpoints 401 (live), callbacks 400 (reachable); **web Google/Microsoft OAuth unaffected**; pre-deploy PG backup taken (1.8 MB, restore-list OK); **no schema/migration changes**.

**Local gates (all green on `2fca3a0`):** backend+mobile `tsc`; tests 22 new + **728/728** backend suite; expo-doctor 18/18; expo export android+iOS; expo prebuild android `--clean`; web production build (109/109).

```
ANDROID VERSION CODE:     8
IOS BUILD NUMBER:         4
BACKEND DEPLOY:           DONE + verified (commit 2fca3a0; web OAuth no-regression)
CODEMAGIC BUILD:          PENDING — operator triggers android-preview on main (versionCode 8)
APK:                      PENDING (versionCode 8)
DEVICE QA:                PENDING — physical Android device required
GOOGLE/MICROSOFT MOBILE OAUTH: NOT marked passed until real provider consent returns to the installed app
READY FOR PRODUCTION AAB: NO — gated on versionCode-8 physical-device QA
```

---

# UPDATE 2 — ACTUAL device-log root cause of the boot freeze (2026-06-15)

The versionCode-4 APK (which contained "UPDATE 1"'s notification fix) **still froze
on the "Z" splash and ANR'd** on a physical Galaxy S26 Ultra. I captured a live
`adb logcat` from that exact build and found the real, evidence-based cause —
which is **different** from the import-time-notification theory in UPDATE 1.

**Device error (logcat, release Hermes, versionCode 4):**
```
I ReactNativeJS: Running "main"
E ReactNativeJS: TypeError: undefined is not a function
E ReactNativeJS:   in AuthBoot ... in ErrorBoundary ... in ExpoRoot
   stack: anonymous@1:1868131  commitHookEffectListMount  commitHookPassiveMountEffects  flushPassiveEffects
```

**Root cause:** the throw is in a **passive `useEffect`** (`commitHookEffectListMount`),
not render. Hermes (`hermes-2024-11-12-RNv0.76.2`) **does not implement
`Array.prototype.findLast` / `findLastIndex`**, but **`@react-navigation/routers`**
(`StackRouter`/`TabRouter`, used by expo-router 4) calls them inside
`getStateForAction` / `getInitialState`. The **first navigation action**
(`router.replace` from `useAuthGate`, which lives in `AuthBoot`) reaches that code →
`undefined is not a function`. Because it throws in a passive effect, the
`ErrorBoundary` catches it by **unmounting `AuthBoot`**, whose unmount cleanup runs
`clearTimeout` on the 5s splash-dismiss timer → the native splash never hides →
frozen "Z" → ANR. TypeScript's lib declares these methods, so it passed
`tsc`/`expo-doctor`/`expo export` and only failed at runtime under Hermes.

**Fix (commit on main):**
- **`mobile/src/lib/polyfills.ts` (NEW, imported FIRST in `app/_layout.tsx`)** — a
  feature-detected polyfill for `Array.prototype.findLast` / `findLastIndex` / `at`.
  No-op if the engine already has them, so it's safe on every engine/platform.
  Tested in `mobile/tests/polyfills.test.ts` (6 tests, native-parity).
- **Splash can no longer freeze:** a **module-level** `setTimeout`→`hideAsync` in
  `_layout.tsx` (immune to component unmount) + `SplashScreen.hideAsync()` in
  `ErrorBoundary.componentDidCatch` (so the recovery screen is never hidden behind
  the splash).
- **Optional boot hooks made fail-open** with named logging (`[boot:<hook>]`):
  `useOAuthDeepLink` (Linking), `usePushNotifications` (response listener),
  `useAppLifecycle` (AppState). A new `guard()` in `safeInit.ts`. So any *other*
  undefined boot call degrades gracefully and is named in logcat, instead of
  freezing.
- `android.versionCode` 4 → **5**.

**Validation (this commit):** polyfill + safeInit tests 10/10 · `tsc` 0 errors ·
`expo-doctor` 18/18 · `expo export` android OK (polyfill confirmed in the Hermes
bundle; module count 1545→1546).

**Diagnosis method (how the device was read, for reproducibility):** fresh Google
`platform-tools` adb → confirmed installed `versionCode=5`-predecessor `=4` →
`adb logcat` of a clean relaunch → isolated the `ReactNativeJS` stack. Symbolication
of the Hermes offsets was attempted (local `expo export:embed` + `metro-symbolicate`,
incl. a full `npm ci` of Codemagic's exact tree) but the local bundle isn't
byte-identical to the gradle-embedded one, so offsets didn't map — root cause was
instead established from the component stack + a multi-agent audit of the boot path
that pinpointed the `findLast`/`findLastIndex` calls in `@react-navigation/routers`.

**Status:** fix applied + locally validated; **not** marked resolved until a
versionCode-5 APK is built on Codemagic and verified opening on the device.

---

# ZentroMeet Mobile — Android Preview Build & Physical-Device QA

**Date:** 2026-06-15
**Tested commit:** (pre-build validation) `mobile/app.json` blockedPermissions change on top of `3721e59`
**Expo SDK:** 52 · **RN:** 0.76.9 · **react-native-screens:** 4.4.0

> ## Scope-of-execution disclosure (read first)
> The actual **EAS cloud build** and the **physical-device QA (Phases 5–13)** were **NOT performed**, for two unavoidable reasons:
> 1. **EAS is not authenticated** on this machine (`eas whoami` / `expo whoami` → *Not logged in*). The task's Phase 2 explicitly says to stop and have the owner run `eas login` rather than request/print a password.
> 2. There is **no physical Android device (or `adb`) available** in this environment. Per rule 8, I will not claim install/boot/auth/push success without real device evidence.
>
> Everything that does **not** require authentication or a device was completed and is reported with real command output: full config verification (Phase 1), the reproducible pre-build gate (Phase 3: `npm ci` → `tsc` → `expo-doctor` → `expo export`), and native-config validation via `expo prebuild`. All device-QA fields below are **PENDING**, not pass/fail.

---

## Phase 1 — Build configuration ✅ VERIFIED

| Item | Value | Status |
|---|---|---|
| Android package | `com.zentromeet.app` | ✅ |
| iOS bundle id | `com.zentromeet.app` | ✅ |
| Scheme | `zentromeet` | ✅ |
| App version | `0.3.0` | ✅ |
| Android versionCode | `3` (unchanged — no bump needed yet) | ✅ |
| iOS buildNumber | `3` | ✅ |
| iPad | `ios.supportsTablet: true` | ✅ |
| Android permissions | INTERNET, POST_NOTIFICATIONS, VIBRATE, WAKE_LOCK, RECEIVE_BOOT_COMPLETED — **unique, no dups** | ✅ |
| iOS associatedDomains | `["applinks:app.zentromeet.com"]` — **unique** | ✅ |
| Android intentFilters | **2** (zentromeet://oauth, https app.zentromeet.com/m) — **no dups** | ✅ |
| API base URL | `https://app.zentromeet.com` — **no localhost** | ✅ |
| Privacy URL | `https://app.zentromeet.com/privacy` → **200** | ✅ |
| Terms URL | `https://app.zentromeet.com/terms` → **200** | ✅ |
| Notification icon / adaptive icon | `notification-icon.png` 96×96; `adaptive-icon.png` 1024×1024 | ✅ |
| App icon | `icon.png` 1024×1024 (RGB, no alpha — iOS-compliant) | ✅ |
| EAS projectId / owner | `015c17c4-…` / `seansyed` | ✅ |
| runtimeVersion | `{ policy: appVersion }` | ✅ |
| Google/Microsoft OAuth | mobile deep-link flow; backend live (`/api/auth/oauth/google/start?mobile=1` → **307**) | ✅ |

**Native-config validation (`expo prebuild --platform android`, exit 0):** AndroidManifest generates correctly with the right package, deep-link schemes, and the 5 declared permissions. **Found & fixed:** the default native template auto-injected 3 unused sensitive permissions (`READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW`). Added `android.blockedPermissions` to `app.json`; re-running prebuild confirmed they now carry `tools:node="remove"` (stripped from the final APK). This is a Play Store readiness improvement (minimal permissions → smoother review + simpler data-safety form).

## Phase 2 — EAS authentication ⛔ NOT AUTHENTICATED (owner action required)
`eas whoami` → **Not logged in**. `expo whoami` → **Not logged in**. **Owner must run:** `cd mobile && npx eas login` (account: `seansyed`). I will not request or print credentials.

## Phase 3 — Build profile + pre-build gate ✅ PASS
**Preview profile (`eas.json`) already meets all requirements** — `distribution: internal`, `android.buildType: apk` (installable APK), `EXPO_PUBLIC_API_BASE_URL=https://app.zentromeet.com`, **no** `developmentClient`, no embedded secrets. No correction needed.

Reproducible gate (run from `mobile/`):
| Command | Result |
|---|---|
| `npm ci` (committed lockfile) | ✅ clean install, lockfile consistent |
| `npx tsc --noEmit` | ✅ **0 errors** |
| `npx expo-doctor` | ✅ **18/18 checks passed** |
| `npx expo export --platform android` | ✅ Hermes bundle produced |
| `npx expo prebuild --platform android` | ✅ exit 0, manifest valid |

## Phase 4 — Android preview build ⏳ PENDING (blocked on Phase 2)
**Not started** — requires EAS auth. Once the owner runs `eas login`, the build is:
```
cd mobile
npm ci
npx eas build --platform android --profile preview
```
Record from the build: EAS build ID, git commit, version/versionCode, SDK, profile, status, artifact URL (APK), signing-credential source (EAS-managed keystore). **Do not expose the keystore.**

## Phases 5–13 — Physical-device QA ⏳ PENDING (no device available)
None of the on-device tests were run (no physical device / `adb` here). They must be executed on a real Android phone after installing the preview APK, with `adb logcat` captured. Checklist below for the tester.

<details><summary>Device QA checklist (fill during real QA)</summary>

- **Boot/nav (P6):** no white screen; no "undefined is not a function"; splash shows→exits; AuthBoot completes; no redirect loop; login → tabs; Android back; cold start after force-quit; resume after background. `adb logcat | grep -E "FATAL EXCEPTION|ReactNativeJS|TypeError|SecureStore|Notifications"`.
- **Auth (P7):** email login/invalid/logout/persistence; Google OAuth round-trip (browser→`zentromeet://oauth/callback`→app, no loop); Microsoft OAuth (+record any unverified-publisher warning verbatim); confirm **no tokens/cookies in logcat**.
- **Screens (P8):** Home, Calendar, Appointments, detail, reschedule, cancel, Customers, customer detail, Settings, calendar connections, sessions/security, onboarding, quick-create — loading/empty/error/offline/retry/pull-to-refresh; no overflow; keyboard; back nav.
- **Appointments (P9):** view → detail (date/tz/customer) → reschedule (API+UI) → cancel (status) → confirm web+mobile parity → duplicate-submit prevented.
- **Push (P10) — mandatory (was disabled):** Android 13+ permission prompt; Expo token obtained; registered to backend (`POST /api/mobile/push-tokens`) for the right user; no dup on relaunch; logout deactivates; foreground/background/terminated delivery; tap → `/appointments/[id]`; channel exists; icon renders; no expo-notifications crash. Internal test notifications only.
- **Offline/lifecycle (P11):** background→foreground stale-refresh (no dup burst, no loop); offline messaging; no cross-tenant cache; reconnect; expired-session-while-backgrounded; 401/403/404/429/500 handling.
- **Security (P12):** tokens in SecureStore (not AsyncStorage); logout clears; User A→User B no leakage; HTTPS only; no secrets in JS bundle; deep-link param validation; appointment IDs can't cross tenants.
- **UI/a11y (P13):** small/standard/large widths; safe areas; text scaling; long names/emails; touch targets; icon-button labels; contrast.
</details>

---

## Summary

```
ANDROID PREVIEW BUILD:     NOT BUILT — blocked on EAS auth (owner: `npx eas login`)
EAS BUILD ID:              n/a (build not started)
TESTED COMMIT:             3721e59 (+ app.json blockedPermissions, this report)
DEVICE:                    n/a — no physical Android device available in this environment
ANDROID VERSION:           n/a
INSTALL:                   PENDING (needs APK + device)
COLD START:                PENDING (device)
BACKGROUND/RESUME:         PENDING (device)
EMAIL LOGIN:               PENDING (device)
GOOGLE LOGIN:              PENDING (device) — backend deep-link flow verified live (307)
MICROSOFT LOGIN:           PENDING (device)
APPOINTMENTS:              PENDING (device) — code + API validated
RESCHEDULE:                PENDING (device)
CANCELLATION:              PENDING (device)
PUSH TOKEN:                PENDING (device) — hook re-enabled + bundles clean; needs real device
FOREGROUND NOTIFICATION:   PENDING (device)
BACKGROUND NOTIFICATION:   PENDING (device)
TERMINATED NOTIFICATION:   PENDING (device)
NOTIFICATION DEEP LINK:    PENDING (device)
OFFLINE HANDLING:          PENDING (device) — OfflineBanner + lifecycle hook present
SECURE STORAGE:            CODE-VERIFIED (expo-secure-store wrapper); device confirm PENDING
TENANT ISOLATION:          BACKEND-VERIFIED (web audit, no P0/P1); mobile device confirm PENDING
UI:                        PENDING (device)
P0 ISSUES:                 0 found in build config / pre-build gate
P1 ISSUES:                 0 found in build config / pre-build gate
                           (1 P2 fixed: blocked 3 unused sensitive Android permissions)
ANDROID DECISION:          CONDITIONAL GO — all build INPUTS validated (config, npm ci, tsc,
                           expo-doctor, export, prebuild). Authenticated EAS build + physical-device
                           QA (boot, auth, appointments, push) are REQUIRED and NOT yet done.
READY FOR PRODUCTION AAB:  NO — gated on a passing preview APK + physical-device QA per the rules.
```

## Remaining actions (owner)
1. `cd mobile && npx eas login` (account `seansyed`), confirm `eas whoami`.
2. `npx eas build --platform android --profile preview` → install the APK on a physical Android phone.
3. Run Phases 5–13 with `adb logcat` captured; fill this report's device sections with real evidence.
4. If green, only then produce the production AAB (`build:android:production`) and submit (separate task).

---

# UPDATE — Codemagic Android Preview (replacing EAS for this build), 2026-06-15

Build service switched from EAS to **Codemagic** for the Android preview. Audited + corrected `codemagic.yaml`.

## Config audit (Phase 1) — `codemagic.yaml` (3 workflows)
| Workflow | Method | Notes |
|---|---|---|
| `android-preview` | **`expo prebuild` + Gradle** (no EAS) | working_directory `mobile`, linux_x64, Node 20.17.0, Java 17 → installable **APK** |
| `android-production` | Gradle `bundleRelease` (no EAS) | signed **AAB**; requires `zentromeet_android_keystore`; reads versionCode from app.json |
| `ios-production` | Orchestrates **EAS** iOS build then downloads `.ipa` | EAS is used here only (iOS needs Mac/EAS) — out of scope for this Android task |

## Corrections applied to `android-preview` (Phases 2–3)
- **Added the validation gate** (fail-fast before the long Gradle build): `npx tsc --noEmit`, `npx expo-doctor`, `npx expo export --platform android` — all fatal. (expo-doctor is fatal on purpose: dependency drift was the prior boot-crash cause.)
- **Enforced reproducible install:** `npm ci` only (errors if the now-committed `package-lock.json` is missing) — removed the stale "lockfile is gitignored → npm install" fallback.
- **Removed the unnecessary EAS dependency:** deleted the "Verify EAS authentication" step and dropped the `expo_credentials`/`EXPO_TOKEN` group from this workflow. `android-preview` is now fully EAS-free and needs no Expo login. (Build chain: `npm ci` → `tsc` → `expo-doctor` → `expo export` → `expo prebuild --platform android --clean` → `gradlew assembleRelease`/`assembleDebug`.)
- Verified: valid YAML; no `zentromeet-mobile/` refs; no localhost; no `eas build` in `android-preview`; artifacts collect `android/app/build/outputs/apk/{release,debug}/*.apk` + logs; no Play publishing (email notify only); no committed `android/` (it's `.gitignore`d and regenerated by `--clean`).

## Environment / signing (Phases 3–4)
- **Public runtime var:** `EXPO_PUBLIC_API_BASE_URL=https://app.zentromeet.com` — must be set in the Codemagic group **`zentromeet_api`** (Expo inlines `EXPO_PUBLIC_*` into the JS bundle; Codemagic does not `$VAR`-substitute inside `vars:`). No secrets belong in `EXPO_PUBLIC_*`. The app reads OAuth client IDs server-side (web backend) — the mobile app does not need `EXPO_PUBLIC_GOOGLE_/MICROSOFT_CLIENT_ID`. `eas.projectId` lives in `app.json`. No telemetry/Sentry secret required.
- **Signing:** workflow uses Codemagic Android keystore **`zentromeet_android_keystore`** if present (→ signed release APK), else `assembleDebug` (debug-signed, still installable). **Upload the keystore in the Codemagic UI** (Teams → Code Signing → Android keystores) — do NOT commit it. **Recommendation:** sign the preview with the **same permanent upload key intended for Google Play**, so tester installs can later be upgraded by the Play build (an APK signed with a different/debug key cannot be upgraded over a Play release outside Play).

## Codemagic project setup (Phase 5) — owner action (not verifiable from CLI)
Connect in the Codemagic UI: Add application → GitHub → `seansyed/zentroslots` → use `codemagic.yaml`, **configuration path `codemagic.yaml`**. Then add the `zentromeet_api` env group + the `zentromeet_android_keystore`.

## Build (Phase 8) — NOT TRIGGERED
No Codemagic API token is available on this machine (`CODEMAGIC_API_TOKEN` unset) and I cannot operate the Codemagic UI, so I did not (and cannot) trigger or monitor the cloud build. **Owner triggers** `android-preview` from the Codemagic dashboard (manual run on `main`) — or pushing to `develop` auto-triggers it.

## Codemagic summary (Phase 9)
```
CODEMAGIC PROJECT:        seansyed/zentroslots  (connect/confirm in Codemagic UI — not CLI-verifiable)
CONFIG PATH:              codemagic.yaml
WORKFLOW:                 android-preview
BUILD NUMBER:             n/a — NOT TRIGGERED (no Codemagic API token / UI access here)
BUILD COMMIT:             (this push to main)
BUILD STATUS:             NOT TRIGGERED
NODE VERSION:             20.17.0  (from codemagic.yaml)
JAVA VERSION:             17       (correct for Expo SDK 52 / RN 0.76)
ANDROID PACKAGE:          com.zentromeet.app
APP VERSION:              0.3.0
VERSION CODE:             3  (unchanged — no bump needed for a preview)
SIGNING:                  zentromeet_android_keystore if configured (signed release APK),
                          else assembleDebug (debug-signed). Prefer the permanent Play upload key.
ARTIFACT TYPE:            APK (release if keystore present; debug otherwise)
APK FILE:                 pending build (expected android/app/build/outputs/apk/release/app-release.apk)
APK URL:                  pending build (Codemagic → Builds → Artifacts)
APK SIZE:                 pending build
LOCAL VALIDATION:         PASS — npm ci (committed lockfile), tsc 0 errors, expo-doctor 18/18,
                          expo export android, expo prebuild android (all run this session)
DEVICE INSTALL:           PENDING — needs the APK + a physical Android device
PHYSICAL DEVICE QA:       PENDING — no device available to me (Phases 5–13 checklist above)
READY FOR PRODUCTION AAB: NO — gated on a passing preview APK + physical-device QA
NEXT ACTION:              Owner: confirm Codemagic app↔repo + config path codemagic.yaml;
                          add zentromeet_api env group + zentromeet_android_keystore; trigger
                          android-preview; install APK on a phone; run device QA.
```

## Remaining risks
- The re-enabled hooks (push/lifecycle/error/telemetry) compile and bundle cleanly and the SDK-52 dep drift (the prior crash cause) is fixed, but **on-device boot has not been observed** — device QA is the real confirmation.
- Push end-to-end depends on EAS-managed FCM credentials (configured during the first EAS build) — verify token registration on-device.
- iPad: `supportsTablet:true` ships a native iPad app, but a centered max-width layout polish (so content doesn't stretch) is recommended and best verified in the iPad simulator (separate from this Android task).

---

# UPDATE — APK artifact collection fix (build #7 shipped logs-only zip), 2026-06-15

**Symptom:** Codemagic build #7 (`6a2f80d0d2485dfd093b4caa`, commit `ce26022`) finished successfully — TypeScript, expo-doctor, export, prebuild, Gradle APK, and code-signing all passed — but the only artifact was `zentroslots_7_artifacts.zip` (16.52 KB), with **no APK**.

**Root cause:** Codemagic resolves `artifacts:` globs relative to the workflow **`working_directory` (`mobile`)**, not the repo root. When `codemagic.yaml` moved to the repo root, the artifact globs were given a `mobile/` prefix — which double-nests to `mobile/mobile/android/...` and matches nothing. The two **absolute** `/tmp/*.log` paths still matched, which is exactly why a logs-only 16 KB zip was produced. (Deduced from the build evidence; I do not have Codemagic log/API access to read the raw logs.)

**Fix (`codemagic.yaml`):**
- `android-preview` artifacts: `mobile/android/app/build/outputs/apk/release/*.apk` (+debug) → **`android/app/build/outputs/apk/**/*.apk`** (working-dir-relative, robust `**`).
- `android-production`: → **`android/app/build/outputs/bundle/**/*.aab`**.
- `ios-production`: `mobile/ios-artifacts/*.ipa` → **`ios-artifacts/*.ipa`** (same latent bug; iOS build *logic* unchanged).
- New **"Verify APK + print metadata"** step (after Gradle): prints `pwd`, all `*.apk`/`*.aab`, and the APK path/size/`sha256sum`, and **fails the build if no APK is found** after a "successful" Gradle build.
- New **"Verify APK signature + package"** step: runs `apksigner verify --print-certs` + `aapt2 dump badging` to confirm the APK is signed by the `ZentroMeet` identity and the package is `com.zentromeet.app` — prints only the public certificate (SHA-256) + package, never any password/key. Non-fatal.

**Validation:** YAML valid; android-preview remains EAS-free with no Play publishing; android-production AAB glob corrected; expected APK ≈ `android/app/build/outputs/apk/release/app-release.apk` (signed, multi-MB).

**Not done here (no access):** I cannot trigger/monitor the Codemagic build or read its logs (no `CODEMAGIC_API_TOKEN`/UI), and cannot run `apksigner` on the artifact locally (no APK + no Android build-tools). The new in-CI steps will print the signature/cert/SHA-256 on the next run. **Owner re-runs `android-preview`** from `main`; the next build's verify step prints the cert + the APK becomes a real multi-MB artifact.

```
ROOT CAUSE:               artifact globs resolved from working_directory(mobile); mobile/ prefix double-nested -> no APK match (logs-only zip)
OLD ARTIFACT GLOB:        mobile/android/app/build/outputs/apk/{release,debug}/*.apk
REAL APK PATH:            android/app/build/outputs/apk/release/app-release.apk  (working-dir-relative; signed release)
NEW ARTIFACT GLOB:        android/app/build/outputs/apk/**/*.apk
APK SIGNED:               expected YES (build #7 "code signing setup completed"); confirmed by the new apksigner step on next run
SIGNING IDENTITY:         ZentroMeet  (Codemagic Android keystore)
CERTIFICATE SHA-256:      ED:7D:35:C5:57:98:FC:CE:10:27:C5:9D:E6:E6:58:A1:56:61:57:0B:A6:65:8A:2C:4C:9B:4D:01:46:DF:DD:6F (the uploaded ZentroMeet upload key) — to be confirmed by the new apksigner step
CONFIG COMMIT:            (this push to main)
NEW BUILD NUMBER:         PENDING — owner re-runs android-preview (no Codemagic API/UI access here)
NEW BUILD STATUS:         PENDING
APK FILE:                 PENDING (expected app-release.apk, multi-MB)
APK SIZE:                 PENDING
APK URL:                  PENDING (Codemagic -> Builds -> Artifacts)
DEVICE QA:                PENDING — physical Android device required
READY FOR PRODUCTION AAB: NO — gated on a real APK installed + tested on a physical device
```

---

# UPDATE — Release-APK white screen fix (boot hardening), 2026-06-15

**Symptom:** the first physical-device preview APK installed but opened to a permanent **white blank screen** (P0).

**Log availability:** the referenced `zm-crash.txt` was **not present** on this machine (searched repo, Downloads, Documents, Desktop, user profile), so I could not read the device log. Per the task's explicit directive, the unsafe boot-time side effects were removed **regardless** — the fix below eliminates the entire white-screen *class*, not just one line.

**Root cause (code-evident, highest confidence):** `mobile/src/hooks/usePushNotifications.ts` called `Notifications.setNotificationHandler(...)` as a **module-import-time side effect**. `app/_layout.tsx` imports that module, so the native call ran during **bundle evaluation — before React (and the ErrorBoundary) mounts**. In a **release** build (which strips the dev red-box), if the native module isn't ready/available the root-layout import throws → React never mounts → white screen with no recoverable surface. (Dev/Expo Go masked it; this was the first real release APK.)

**Boot phase:** before React mounts → **not catchable by the ErrorBoundary** (which only catches render-phase errors). That's why it was white, not the recovery screen.

**Fixes (all in `mobile/`):**
- **Notification init:** removed the top-level `setNotificationHandler`; it now runs via a **run-once, never-throws, retryable** wrapper (`src/lib/safeInit.ts → createRunOnceSafe`) from a **post-mount effect** in `usePushNotifications`. Push stays fully enabled; it can no longer crash boot.
- **Other hooks (kept enabled, made fail-open):** `useNavigationBreadcrumbs` telemetry wrapped in try/catch; `useAppLifecycle`'s `addNotificationReceivedListener` attach wrapped so a notifications-unavailable failure returns a no-op cleanup instead of bubbling. `usePushNotifications`/`useGlobalErrorHandlers` were already guarded. **No hook disabled.**
- **Boot fallback:** `_layout.tsx` no longer returns `null` while hydrating — it renders a **branded loading screen** (`BootLoading`), so if the native splash dismisses before hydration the user sees a styled loader, never white. The existing **ErrorBoundary** already provides a recoverable error screen with **Retry**; added a safe **"Reset app data & sign out"** action (clears the persisted session so a corrupt stored session can't replay).
- **baseUrl:** removed `experiments.baseUrl: "/mobile"` from `app.json` — it's a **web-hosting-only** setting and a known expo-router native white-screen footgun; native must not search a non-existent `/mobile` path. (If the web export is revived, set the base URL at export time instead.)

**Tests:** `mobile/tests/safeInit.test.ts` (4, passing via `tsx --test`): run-once on success; throwing init is contained (fail-open, no throw); retry after failure can succeed then no-ops; throwing reporter is swallowed. (Full RN/component tests need a `jest-expo` setup not currently configured — deferred.)

**Validation (this commit):** `tsc --noEmit` 0 errors · `expo-doctor` 18/18 · `expo export --platform android` OK · `expo prebuild --platform android --clean` OK (manifest correct; sensitive perms still blocked). `android.versionCode` 3 → **4** (so the corrected APK is distinguishable). Generated `android/`/`dist/` cleaned (not committed).

```
ROOT CAUSE:               import-time Notifications.setNotificationHandler() ran during bundle eval,
                          before React/ErrorBoundary mounted -> release build threw -> white screen
DEVICE ERROR:             NOT AVAILABLE (zm-crash.txt not found on this machine; not fabricated). Root
                          cause from code analysis; fix removes the entire white-screen class.
SOURCE FILE:              mobile/src/hooks/usePushNotifications.ts (module-top setNotificationHandler)
BOOT PHASE:               pre-React-mount (bundle evaluation) -> ErrorBoundary CANNOT catch
FIX:                      move native init off import into guarded post-mount run-once; branded boot
                          loader instead of null; fail-open optional hooks; drop web-only baseUrl
NOTIFICATION INIT:        createRunOnceSafe wrapper, called from a post-mount effect; never throws; retryable
OTHER HOOKS:              all kept ENABLED; made fail-open (none disabled)
BASE URL:                 removed experiments.baseUrl "/mobile" (web-only; broke native routing)
BOOT FALLBACK:            BootLoading branded screen + ErrorBoundary Retry + "Reset app data & sign out"
TESTS:                    mobile/tests/safeInit.test.ts (4 passing)
TYPECHECK:                PASS (0 errors)
EXPO DOCTOR:              PASS (18/18)
EXPORT:                   PASS (android bundle)
PREBUILD:                 PASS (manifest verified)
VERSION CODE:             4  (was 3)
COMMIT:                   (this push to main)
CODEMAGIC BUILD:          PENDING — owner re-runs android-preview (no Codemagic API/UI access here)
APK:                      PENDING (new build, versionCode 4)
DEVICE RETEST:            PENDING — physical Android device required (cannot run here)
P0 STATUS:                FIX APPLIED + LOCALLY VALIDATED; NOT marked resolved until the rebuilt APK
                          visibly opens on the physical device (per the rule)
READY FOR FURTHER QA:     YES once the versionCode-4 APK is built + installed
```

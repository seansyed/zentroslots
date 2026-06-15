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

## Remaining risks
- The re-enabled hooks (push/lifecycle/error/telemetry) compile and bundle cleanly and the SDK-52 dep drift (the prior crash cause) is fixed, but **on-device boot has not been observed** — device QA is the real confirmation.
- Push end-to-end depends on EAS-managed FCM credentials (configured during the first EAS build) — verify token registration on-device.
- iPad: `supportsTablet:true` ships a native iPad app, but a centered max-width layout polish (so content doesn't stretch) is recommended and best verified in the iPad simulator (separate from this Android task).

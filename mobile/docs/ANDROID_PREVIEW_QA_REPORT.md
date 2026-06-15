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

Build service switched from EAS to **Codemagic** for the Android preview. Audited + corrected `mobile/codemagic.yaml`.

## Config audit (Phase 1) — `mobile/codemagic.yaml` (3 workflows)
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
Connect in the Codemagic UI: Add application → GitHub → `seansyed/zentroslots` → use `codemagic.yaml`, **configuration path `mobile/codemagic.yaml`**. Then add the `zentromeet_api` env group + the `zentromeet_android_keystore`.

## Build (Phase 8) — NOT TRIGGERED
No Codemagic API token is available on this machine (`CODEMAGIC_API_TOKEN` unset) and I cannot operate the Codemagic UI, so I did not (and cannot) trigger or monitor the cloud build. **Owner triggers** `android-preview` from the Codemagic dashboard (manual run on `main`) — or pushing to `develop` auto-triggers it.

## Codemagic summary (Phase 9)
```
CODEMAGIC PROJECT:        seansyed/zentroslots  (connect/confirm in Codemagic UI — not CLI-verifiable)
CONFIG PATH:              mobile/codemagic.yaml
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
NEXT ACTION:              Owner: confirm Codemagic app↔repo + config path mobile/codemagic.yaml;
                          add zentromeet_api env group + zentromeet_android_keystore; trigger
                          android-preview; install APK on a phone; run device QA.
```

## Remaining risks
- The re-enabled hooks (push/lifecycle/error/telemetry) compile and bundle cleanly and the SDK-52 dep drift (the prior crash cause) is fixed, but **on-device boot has not been observed** — device QA is the real confirmation.
- Push end-to-end depends on EAS-managed FCM credentials (configured during the first EAS build) — verify token registration on-device.
- iPad: `supportsTablet:true` ships a native iPad app, but a centered max-width layout polish (so content doesn't stretch) is recommended and best verified in the iPad simulator (separate from this Android task).

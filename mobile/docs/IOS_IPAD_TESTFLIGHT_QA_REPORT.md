# ZentroMeet iOS / iPad — TestFlight QA Report

Status of the iOS (iPhone + iPad) build + TestFlight pipeline.

> **2026-06-16:** iOS push needs an **APNs Auth Key registered with Expo** (not just
> the Codemagic signing capability) — the backend delivers via the Expo Push API.
> Full operator steps in [CODEMAGIC_NATIVE_IOS_BUILD.md §10](CODEMAGIC_NATIVE_IOS_BUILD.md)
> and [../../PRELAUNCH_BLOCKER_CLOSEOUT_REPORT.md](../../PRELAUNCH_BLOCKER_CLOSEOUT_REPORT.md) (WS5). Build number 12.

---

# UPDATE 2 — iOS push readiness (pre-launch audit), 2026-06-16

**iOS buildNumber:** 12 (was 11). Full detail in [../../PRELAUNCH_EMAIL_PUSH_STRIPE_AUDIT_REPORT.md](../../PRELAUNCH_EMAIL_PUSH_STRIPE_AUDIT_REPORT.md).

iOS push provider = **Expo Push → APNs**. The app requests notification permission and
registers an Expo token (`getExpoPushTokenAsync`) which requires the **`aps-environment`**
entitlement + an **APNs Auth Key (.p8)** on the Apple side. Backend queue (`push_deliveries`)
+ `push:deliver` cron are live. **Production tokens/deliveries = 0/0 → iOS push is UNVERIFIED.**

**iOS PUSH — BLOCKED (OPERATOR):**
- No APNs Auth Key configured; no signed TestFlight build yet (native iOS workflow is ready —
  see [CODEMAGIC_NATIVE_IOS_BUILD.md](CODEMAGIC_NATIVE_IOS_BUILD.md), needs the App Store
  Connect API key integration + APNs key).
- The App Store provisioning profile must include **Push Notifications** + **Associated Domains**
  capabilities (the only two entitlements the app genuinely uses).
- Physical iPhone **and** iPad push verification is **PENDING** — do not claim iOS push
  production-ready until a signed TestFlight build delivers a push on a real device. No iOS
  device results are fabricated.

Backend push fixes that also benefit iOS (deployed `69cacdf`): single-device logout token
removal; push body absolute time rendered in the staff timezone with an explicit abbreviation.

---

# UPDATE 1 — ios-production converted to a NATIVE Codemagic build (EAS removed), 2026-06-16

**Commit:** (this push to `main`) · **iOS buildNumber:** `11` (unchanged — CI
config rewrite only) · **Android:** untouched.

## What changed

The `ios-production` Codemagic workflow no longer delegates the iOS compile to
EAS Build. It now compiles **natively on a Codemagic `mac_mini_m2`**: `npm ci`
→ gates (tsc / expo-doctor / unit tests) → `expo export` (JS validate) →
`expo prebuild --platform ios --clean` → `pod install` → discover
workspace+scheme → `xcode-project use-profiles` (automatic Apple signing) →
`xcode-project build-ipa` (Xcode archive + App Store export) → IPA validation
→ flag-gated TestFlight upload via `app-store-connect publish`.

Expo is retained; the project is NOT ejected; `ios/` stays git-ignored and is
regenerated each build. Full detail in
[CODEMAGIC_NATIVE_IOS_BUILD.md](CODEMAGIC_NATIVE_IOS_BUILD.md).

## EAS removed from the iOS workflow

- ❌ `EXPO_TOKEN` requirement — gone (iOS workflow references none).
- ❌ `eas build --platform ios … --wait` — replaced by native Xcode archive.
- ❌ EAS build polling / `eas build:view` / `.ipa` download — IPA is built locally.
- ❌ `eas submit` — replaced by Codemagic `app-store-connect publish --testflight`.
- ❌ "Verify EAS authentication" / "Trigger EAS production iOS build" steps — removed.
- ❌ `expo_credentials` group on iOS — removed (iOS no longer references it).

`eas.json` is **retained** as the optional local `npm run build:*`/`submit:*`
fallback only — no Codemagic workflow uses it.

## Signing + entitlements

- **Automatic signing** via the Codemagic App Store Connect API-key integration
  (`integrations.app_store_connect: zentromeet_asc_api_key`) +
  `environment.ios_signing { distribution_type: app_store, bundle_identifier:
  com.zentromeet.app }`. No certs/profiles/keys in git.
- **Entitlements genuinely used (audited):** `aps-environment` (remote push) and
  `com.apple.developer.associated-domains` (`applinks:app.zentromeet.com`).
  NOT used: Sign in with Apple, background modes, Keychain Sharing.

## iPhone + iPad

`ios.supportsTablet = true` → one universal IPA. The "Validate IPA" step
asserts `UIDeviceFamily` contains both `1` (iPhone) and `2` (iPad), so a
non-universal build fails CI.

## TestFlight

- Held behind `PUBLISH_TO_TESTFLIGHT` (default `"false"`): the workflow builds +
  validates a signed App Store IPA and **uploads nothing** by default.
- When `"true"`: `app-store-connect publish --path build/ios/ipa/*.ipa
  --testflight` — TestFlight beta review **only** (no `--app-store`, so never
  App Store review). NOT EAS submit.

## Local validation (this commit — config only; the native build itself runs on macOS)

```
codemagic.yaml YAML parse:     PASS (js-yaml) — 3 workflows
android-preview vs HEAD:       IDENTICAL (preserved)
android-production vs HEAD:    IDENTICAL (preserved)
ios-production references EXPO_TOKEN / eas-cli / expo_credentials: NONE
ios instance_type:            mac_mini_m2
ios signing:                  automatic (integration + ios_signing app_store / com.zentromeet.app)
ios artifacts:                build/ios/ipa/*.ipa, zentromeet-dsyms.zip, xcodebuild logs
expo prebuild --platform ios (Windows): correctly refuses (iOS prebuild requires macOS/Linux) — confirms ios/ is generated on the mac runner, not committed
```

The Xcode archive, CocoaPods install, signing, IPA export, and TestFlight
upload can only run on the Codemagic macOS machine — they are **not** verifiable
from the Windows dev box. They are statically validated here (YAML structure,
step ordering, signing config, artifact globs, validation gates).

## Required Codemagic UI actions (operator) — build cannot run until done

1. App Store Connect **API key integration** named `zentromeet_asc_api_key`
   (.p8 + Issuer ID + Key ID, App Manager access).
2. `zentromeet_api` env group → `EXPO_PUBLIC_API_BASE_URL`.
3. `app_store_credentials` env group (Secure) → `APP_STORE_CONNECT_ISSUER_ID` /
   `APP_STORE_CONNECT_KEY_IDENTIFIER` / `APP_STORE_CONNECT_PRIVATE_KEY` (only
   needed to publish).
4. App Store Connect app record for `com.zentromeet.app` must already exist
   (no duplicate). App ID must have Push Notifications + Associated Domains.
5. Flip `PUBLISH_TO_TESTFLIGHT="true"` only after 1+3 are verified.

See [CODEMAGIC_NATIVE_IOS_BUILD.md §10](CODEMAGIC_NATIVE_IOS_BUILD.md) for the
full step-by-step.

```
IOS BUILD STRATEGY:          native Codemagic macOS (Xcode) build — no EAS
EAS REMOVED (iOS):           YES
EXPO RETAINED:               YES (managed; ios/ regenerated by prebuild, git-ignored)
CODEMAGIC MACHINE:           mac_mini_m2
XCODE VERSION:               16.2
BUNDLE ID:                   com.zentromeet.app
SUPPORTS IPAD:               YES (universal; UIDeviceFamily 1 + 2 asserted)
BUILD NUMBER:                11 (unchanged — config rewrite only)
SIGNING METHOD:              automatic (App Store Connect API key integration)
EXPO_TOKEN REQUIRED:         NO
TESTFLIGHT METHOD:           app-store-connect publish --testflight (flag-gated; NOT eas submit)
ANDROID WORKFLOWS PRESERVED: YES (android-preview + android-production byte-identical to HEAD)
DEVICE QA:                   PENDING — install the TestFlight build on a physical iPhone AND iPad
READY TO TRIGGER IOS BUILD:  NO — pending Codemagic UI: ASC API key integration + env groups
```

## Physical-device QA (after the first TestFlight build) — PENDING

- [ ] Install on a physical **iPhone** via TestFlight; sign in; appointments list loads.
- [ ] Install on a physical **iPad** (universal binary, not 2× scaled phone app).
- [ ] Google OAuth round-trip (scheme `zentromeet://oauth`).
- [ ] Microsoft OAuth round-trip.
- [ ] Universal Link `https://app.zentromeet.com/...` opens the app (associated domains).
- [ ] Push notification received + tap opens the correct screen (aps-environment).
- [ ] Appointment times match the web dashboard (timezone P0 regression check).

# ZentroMeet Mobile — Codemagic CI/CD Runbook

The operational guide for building ZentroMeet Mobile Android and iOS
binaries on Codemagic.

> **⚠️ UPDATE 2026-06-16 — iOS now builds NATIVELY on Codemagic (no EAS).**
> The `ios-production` workflow no longer delegates the compile to EAS. It now
> runs the full native toolchain on a macOS `mac_mini_m2` (`expo prebuild` →
> CocoaPods → Xcode archive → App Store IPA → TestFlight via Codemagic's
> `app-store-connect publish`), with **no EAS Build and no `EXPO_TOKEN`**.
> Sections below that describe iOS as "EAS-orchestrated" (the architecture
> diagram, §6c, §9, §13) are **superseded** — the authoritative iOS pipeline is
> [CODEMAGIC_NATIVE_IOS_BUILD.md](CODEMAGIC_NATIVE_IOS_BUILD.md). EAS is retained
> only for optional manual/laptop builds (`npm run build:*` / `submit:*`).

> Companion to `docs/BETA_RELEASE.md` (release runbook) and
> `docs/EAS_BUILD.md` (optional EAS fallback). This document covers the
> **Codemagic** path — fast, directly-downloadable APK/AAB/IPA artifacts
> without a local Xcode/Android Studio, including the native iOS build.

Use Codemagic for all CI builds (both platforms). Use EAS directly only as an
optional manual/laptop fallback.

---

## 1. Architecture overview

```
                                 ┌─────────────────────────────────────┐
                                 │              Codemagic              │
                                 │       (zentroslots.git)             │
                                 │                                     │
GitHub  ── push develop ─────────▶  android-preview   (linux_x64)      │
        ── push main    ─────────▶  android-production(linux_x64)      │
        ── push main    ─────────▶  ios-production    (linux_x64)      │
                                 │         │                           │
                                 │         │                           │
                                 │         ▼                           │
                                 │   ┌──────────────┐                  │
                                 │   │ expo prebuild│  (Android only)  │
                                 │   │ + Gradle     │                  │
                                 │   └──────┬───────┘                  │
                                 │          │                          │
                                 │          ▼                          │
                                 │   .apk / .aab ── Codemagic Artifact │
                                 │                                     │
                                 │   ┌──────────────────────────────┐  │
                                 │   │ eas build --platform ios     │──┼──▶ EAS infra
                                 │   │   --profile production --wait│  │     (real iOS
                                 │   └──────────┬───────────────────┘  │      compile)
                                 │              │                      │
                                 │              ▼                      │
                                 │   eas-cli build:view → .ipa URL     │
                                 │              │                      │
                                 │              ▼                      │
                                 │   curl .ipa ── Codemagic Artifact   │
                                 └─────────────────────────────────────┘
```

Android is compiled **locally on Codemagic** — `expo prebuild` regenerates
the native project, then Gradle produces an APK or AAB. The artifact is
downloadable directly from the Codemagic dashboard.

iOS is **also compiled locally on Codemagic** — on a macOS `mac_mini_m2`,
`expo prebuild --platform ios` regenerates the native project, CocoaPods
installs pods, and `xcode-project build-ipa` archives + exports a signed App
Store `.ipa`. No EAS. The `.ipa` is a directly-downloadable Codemagic artifact,
and an optional flag-gated step uploads it to TestFlight via
`app-store-connect publish`. (The old ASCII diagram below is retained for
history but is superseded — see CODEMAGIC_NATIVE_IOS_BUILD.md.)

---

## 2. Workflows summary

| Workflow | Trigger | Builds | Artifact | Where it runs |
|---|---|---|---|---|
| `android-preview` | push to `develop` + manual | APK (signed if keystore present, else debug) | `.apk` | Codemagic `linux_x64` |
| `android-production` | push to `main` + manual | AAB (signed; keystore required) | `.aab` + `mapping.txt` | Codemagic `linux_x64` |
| `ios-production` | push to `main` + manual | native iOS build (Xcode archive → App Store IPA; optional flag-gated TestFlight) | `.ipa` + dSYMs | Codemagic `mac_mini_m2` |

`cancel_previous_builds: true` on `android-preview` (so rapid develop
pushes don't queue up). `false` on both production workflows — every
main-branch build runs to completion.

---

## 3. One-time setup

### 3a. Connect GitHub

1. Codemagic dashboard → **Add application** → **GitHub** → authorise
   the org → pick the monorepo (`ZentroBizProduction`).
2. **CRITICAL:** Project Settings → **Build** → **Configuration file path**:

   ```
   codemagic.yaml
   ```

   The repo is a monorepo. Without this setting Codemagic looks for
   `codemagic.yaml` at the repo root and fails with "Configuration file
   not found." Each workflow inside the YAML uses
   `working_directory: mobile` so every script step runs
   from the mobile-app root.

### 3b. `EXPO_TOKEN` — NOT required (legacy)

> **`EXPO_TOKEN` / the `expo_credentials` group are no longer required.** After
> the iOS workflow became a native Codemagic build, no workflow needs an Expo
> login. `android-production` still references the `expo_credentials` group in a
> **non-fatal** "Verify EAS authentication" step (the Gradle build succeeds
> without it); `android-preview` and `ios-production` do not reference it at all.
> You can skip creating `EXPO_TOKEN` entirely. (If you keep the group, it's
> harmless; removing the vestigial android-production reference is a safe future
> cleanup.) For an optional manual `eas build`/`submit` from a laptop you'd log
> in interactively (`npx eas-cli login`) rather than set a CI token.

### 3c. Add the public API URL group

> **CRITICAL — name the variable exactly `EXPO_PUBLIC_API_BASE_URL`.**
> Codemagic does NOT perform `$VAR` substitution inside the YAML's
> `vars:` block, so if you name the group variable `API_BASE_URL` and
> try to bind it through the YAML, Expo will inline the literal string
> `"$API_BASE_URL"` into the JS bundle and every Axios call will fail
> with a malformed URL. Bind the public name directly in the group.

1. **Teams** → **Global environment variables** → **Add new group**
   named `zentromeet_api`.
2. Variable: `EXPO_PUBLIC_API_BASE_URL` = `https://app.zentromeet.com`.
   Any `EXPO_PUBLIC_*` env var present at bundle time gets inlined into
   the JS bundle automatically.
3. (Optional) `EAS_PROJECT_ID` — only needed if `app.json` doesn't
   already have `extra.eas.projectId` populated. The recommended path
   is to run `npx eas-cli init` locally once and commit the resulting
   `app.json` change instead of using this env var.

This group feeds the JS bundle (via `EXPO_PUBLIC_API_BASE_URL`) and the
EAS profile environment.

### 3d. Upload Android keystore

1. **Teams** → **Code signing identities** → **Android keystores** →
   **Upload keystore**.
2. Reference name: `zentromeet_android_keystore` (exactly — the YAML
   references this string).
3. Provide the `.keystore` file, keystore password, key alias, key
   password.

Codemagic auto-exposes the following env vars to any workflow that
references the keystore:

| Codemagic-injected var | What it is |
|---|---|
| `CM_KEYSTORE_PATH` | Absolute path to the decrypted keystore on the build VM |
| `CM_KEYSTORE_PASSWORD` | Keystore password |
| `CM_KEY_ALIAS` | Key alias |
| `CM_KEY_PASSWORD` | Key password |

- **`android-production`** — keystore is **required**. The workflow
  fails fast before Gradle if `CM_KEYSTORE_PATH` is unset.
- **`android-preview`** — keystore is **optional**. If absent, the
  workflow falls back to `assembleDebug` and you get a debug-signed
  APK that still installs on any phone.

---

## 4. Environment variables reference

| Variable | Where to set | Required for | Purpose |
|---|---|---|---|
| `EXPO_TOKEN` | `expo_credentials` group | **none (legacy)** | No longer required. Only a non-fatal `android-production` step still references it; `ios-production` does not. Safe to omit. |
| `APP_STORE_CONNECT_ISSUER_ID` | `app_store_credentials` group (Secure) | `ios-production` (only when publishing) | App Store Connect API key Issuer ID. Read by `app-store-connect publish` for the TestFlight upload. |
| `APP_STORE_CONNECT_KEY_IDENTIFIER` | `app_store_credentials` group (Secure) | `ios-production` (only when publishing) | App Store Connect API key ID. |
| `APP_STORE_CONNECT_PRIVATE_KEY` | `app_store_credentials` group (Secure) | `ios-production` (only when publishing) | The `.p8` private-key contents. |
| `PUBLISH_TO_TESTFLIGHT` | `ios-production` workflow env (UI) | optional | `"false"` (default) builds + validates the IPA without uploading; `"true"` uploads to TestFlight via `app-store-connect publish` (beta review only). |
| `EXPO_PUBLIC_API_BASE_URL` | `zentromeet_api` group | all workflows | Backend the app talks to (default `https://app.zentromeet.com`). **MUST be named with the `EXPO_PUBLIC_` prefix** — Expo only inlines vars with that prefix into the JS bundle, and Codemagic does not substitute `$VAR` inside YAML `vars:` blocks. |
| `ANDROID_KEYSTORE` | Code signing → Android keystores (UI upload form) | `android-production` (required), `android-preview` (optional) | The `.keystore` file itself. Codemagic exposes it at runtime as `CM_KEYSTORE_PATH`. |
| `ANDROID_KEYSTORE_PASSWORD` | same | same | Keystore password. Runtime name: `CM_KEYSTORE_PASSWORD`. |
| `ANDROID_KEY_ALIAS` | same | same | Key alias. Runtime name: `CM_KEY_ALIAS`. |
| `ANDROID_KEY_PASSWORD` | same | same | Key password. Runtime name: `CM_KEY_PASSWORD`. |
| App Store Connect API key **integration** | Codemagic → Teams → Team integrations → Developer Portal (named `zentromeet_asc_api_key`) | `ios-production` (signing) | Drives automatic iOS code signing (cert + profile fetch). Referenced via `integrations.app_store_connect`. Not an env var. |

> **Note on Android keystore naming:** when you upload a keystore via
> the **Code signing identities** UI, Codemagic re-exposes it as
> `CM_KEYSTORE_PATH` / `CM_KEYSTORE_PASSWORD` / `CM_KEY_ALIAS` /
> `CM_KEY_PASSWORD`. The `ANDROID_*` names in the table above are the
> conceptual fields you populate in the upload form — `codemagic.yaml`
> consumes the `CM_*` versions.

> **Note on iOS signing + publishing credentials:** the App Store Connect API
> key is configured TWICE in Codemagic — once as a **Developer Portal
> integration** (`zentromeet_asc_api_key`) for automatic code signing, and once
> as the `app_store_credentials` env group (`APP_STORE_CONNECT_ISSUER_ID` /
> `_KEY_IDENTIFIER` / `_PRIVATE_KEY`) read by `app-store-connect publish` for
> the TestFlight upload. Nothing is committed to git. See
> [CODEMAGIC_NATIVE_IOS_BUILD.md](CODEMAGIC_NATIVE_IOS_BUILD.md) §10. EAS submit
> is no longer used by CI.

---

## 5. Triggering builds

### 5a. Automatic

| Branch event | Fires |
|---|---|
| `git push origin develop` | `android-preview` |
| `git push origin main` | `android-production` + `ios-production` |

### 5b. Manual

1. Codemagic dashboard → ZentroMeet Mobile → **Start new build**.
2. Pick the workflow (`android-preview` / `android-production` /
   `ios-production`).
3. Pick a branch (any branch — manual runs are not gated to
   `develop`/`main`).
4. **Start build**.

### 5c. Skipping a workflow on a push

- Add `[skip ci]` anywhere in the commit message — Codemagic ignores
  the push entirely.
- Or pause a workflow from the dashboard: **Workflows** → workflow
  name → **Pause**. Resumes when you toggle it back on.

---

## 6. Build outputs

### 6a. `android-preview`

- **Signed path (keystore uploaded):**
  `android/app/build/outputs/apk/release/*.apk`
- **Unsigned/debug fallback (no keystore):**
  `android/app/build/outputs/apk/debug/*.apk`
- Download from Codemagic dashboard → build → **Artifacts** tab.
- Email lands at `support@zentromeet.com` on both success and
  failure, with a direct artifact link and a QR code for the phone.

### 6b. `android-production`

- AAB at `android/app/build/outputs/bundle/release/*.aab`.
- **No ProGuard mapping.txt** by default — the Expo SDK 52 / RN 0.76
  prebuild template ships with R8 minification disabled
  (`android.enableProguardInReleaseBuilds=false`), so `bundleRelease`
  produces no `mapping/release/mapping.txt`. Without it Play Console
  cannot deobfuscate native crash stack traces. If you want it, add a
  post-prebuild patch step that enables R8 (`printf
  'android.enableProguardInReleaseBuilds=true\nandroid.enableShrinkResources=true\n'
  >> android/gradle.properties`) and re-add
  `android/app/build/outputs/mapping/release/mapping.txt` to the
  workflow's `artifacts:` list.
- Publishes to the dashboard and email.

### 6c. `ios-production`

- Signed App Store `.ipa` at `build/ios/ipa/*.ipa` (built natively by
  `xcode-project build-ipa`; no EAS).
- dSYMs at `zentromeet-dsyms.zip`; Xcode log at `/tmp/xcodebuild_logs/*.log`.
- All available as Codemagic artifacts (direct download).
- The "Validate IPA" step gates the build (universal iPhone+iPad, App
  Store-signed, correct bundle id + build number) — see
  [CODEMAGIC_NATIVE_IOS_BUILD.md](CODEMAGIC_NATIVE_IOS_BUILD.md) §5.

---

## 7. Installing the APK on an Android phone

Four options, fastest first:

1. **QR code from Codemagic** — each artifact in the Codemagic
   dashboard exposes a QR code next to the download link. Scan with
   the phone's camera, tap the URL, the browser downloads the APK.

2. **Email link** — the success email to `support@zentromeet.com`
   contains a direct artifact URL. Open it on the phone.

3. **ADB** — fastest for repeat dev installs:
   ```bash
   adb install -r ~/Downloads/app-release.apk
   ```

4. **Browser side-load** — open the artifact URL on the phone's
   browser, tap the download notification, tap **Install**.

### One-time phone setup for side-loading

1. **Settings** → **Apps** → **Special app access** → **Install
   unknown apps**.
2. Enable the toggle for whichever app delivers the APK (your browser
   for QR/email, **Files** for downloads).
3. First install will prompt Play Protect — tap **Install anyway**.

---

## 8. Uploading the AAB to Google Play

> **Before merging to `main` that fires `android-production`:** bump
> `android.versionCode` in `app.json`. Codemagic reads it directly from
> `app.json`, and Play Console rejects any upload that reuses a
> previously-shipped versionCode. The autoIncrement in `eas.json` only
> applies to EAS-driven builds — it does NOT bump anything for
> Codemagic's local Gradle build.

After `android-production` finishes:

1. Download the `.aab` from Codemagic artifacts. (No mapping.txt by
   default — see § 6b.)
2. **Play Console** → ZentroMeet → choose a track:
   - **Internal testing** for fast tester rollout (no review).
   - **Closed testing** for a wider beta cohort.
   - **Production** for the live store.
3. **Create new release** → upload the `.aab`.
4. (Skip the deobfuscation-file step unless you enabled R8 — see § 6b.)
5. **Save** → **Review release** → **Start rollout**.

### Or stay on the EAS path

Codemagic's AAB is the same shape as EAS's. If you'd rather let EAS
handle the Play upload too (auto-version bump + credential reuse),
build via EAS and submit:

```bash
eas build --platform android --profile production
eas submit --platform android --latest --profile production
```

See `docs/BETA_RELEASE.md` § Android for the full EAS submit playbook.

---

## 9. Submitting the iOS build to TestFlight

The native `ios-production` workflow uploads to TestFlight itself, using
Codemagic's own `app-store-connect publish` CLI — **not** `eas submit`. It is
held behind the `PUBLISH_TO_TESTFLIGHT` flag. Full detail in
[CODEMAGIC_NATIVE_IOS_BUILD.md](CODEMAGIC_NATIVE_IOS_BUILD.md) §4 + §10.

### Enable TestFlight upload from Codemagic

1. **One-time in the Codemagic UI:**
   - Create an **App Store Connect API key integration** named
     `zentromeet_asc_api_key` (Teams → Team integrations → Developer Portal):
     upload the `.p8` + Issuer ID + Key ID. This drives automatic signing.
   - Create the `app_store_credentials` env group (Secure) with
     `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY_IDENTIFIER`,
     `APP_STORE_CONNECT_PRIVATE_KEY` (the same key's values; read by the
     publish CLI).

2. On the `ios-production` workflow → **Environment variables** → set
   `PUBLISH_TO_TESTFLIGHT` = `"true"`.

3. Next time `ios-production` runs, after building + validating the IPA it
   executes:
   ```bash
   app-store-connect publish --path "build/ios/ipa/*.ipa" --testflight
   ```
   `--testflight` = TestFlight beta review only. It deliberately omits
   `--app-store`, so it **never** submits for App Store review.

4. App Store Connect → TestFlight → **Builds** shows the new build in
   ~10-30 min once Apple finishes processing.

While `PUBLISH_TO_TESTFLIGHT="false"` (the default), the workflow still
produces + validates a signed `.ipa` artifact but uploads nothing — safe for
iterating on the build config.

### Optional fallback — manual from your laptop (EAS)

The `eas submit` path still works as an optional fallback if you ever build via
EAS instead of Codemagic:

```bash
cd mobile
npx eas-cli submit --platform ios --latest --profile production
```

This requires a prior `eas build` (EAS owns that artifact) and cached Apple
credentials (`npx eas-cli credentials -p ios`). It is **not** part of CI.

---

## 10. Compatibility audit

Everything in the current project config is preserved by the Codemagic
workflow — nothing in `app.json` or `eas.json` needs to change.

| Project config | Value | How Codemagic preserves it |
|---|---|---|
| `app.json` `scheme` | `zentromeet` | `expo prebuild` regenerates `AndroidManifest.xml` intent filter |
| `app.json` `experiments.baseUrl` | `/mobile` | Read by Expo Router at JS-bundle time — untouched by prebuild |
| `app.json` `version` | `0.3.0` | Used as the human-readable version string in both stores |
| `android.package` | `com.zentromeet.app` | Written to `applicationId` in `android/app/build.gradle` by prebuild |
| `android.versionCode` | `15` (live value in `app.json`) | Read by Codemagic's local Gradle build at AAB compile time. **Must be manually bumped** before each push to `main` that fires `android-production`, otherwise Play Console rejects with "Version code N already used." |
| `ios.bundleIdentifier` | `com.zentromeet.app` | Used by the native `ios-production` build for automatic signing (`ios_signing.bundle_identifier`) + asserted against the built IPA |
| `ios.buildNumber` | `"11"` | Read by `expo prebuild` → `CFBundleVersion`. The native iOS workflow uses it as-is (NO auto-increment) — bump it by hand in `app.json` before a real TestFlight cut |
| `eas.json` `cli.appVersionSource` | `"remote"` (top-level `cli` block, applies to all profiles) | EAS owns the canonical version number remotely. **Important caveat:** Codemagic-built AABs cannot be uploaded via `eas submit --platform android` because the version source mismatch confuses EAS. Upload Codemagic AABs to Play Console directly (§ 8). |
| `eas.json` production profile | `autoIncrement: true` (production-only), `android.buildType: "app-bundle"`, `distribution: "store"`, `channel: "production"` | **Not read by any Codemagic workflow** (both platforms build natively on Codemagic now). Retained only for optional manual `eas build`/`submit` from a laptop. |
| `eas.json` preview profile | `distribution: "internal"`, `android.gradleCommand: ":app:assembleRelease"` | Not used by Codemagic — Codemagic's `android-preview` workflow drives the equivalent Gradle command directly |
| `eas.json` submit production android | `track: "internal"`, `releaseStatus: "draft"` | Used only if you run `eas submit` manually on the AAB — Codemagic does not auto-submit Android |
| Expo Router 4.0.9 | `typedRoutes: true` + `baseUrl: "/mobile"` | Preserved through prebuild (config-plugin only touches native files) |
| Expo SDK 52 / RN 0.76.3 | New Architecture enabled | Codemagic env pins Node 20 + Java 17, which are the SDK 52 + RN 0.76 toolchain requirements |
| `expo-notifications` plugin | Configured in `app.json` | Prebuild applies the config plugin — notification icon/color land in `AndroidManifest.xml` automatically |
| `expo-secure-store`, `expo-web-browser`, `expo-font` | Listed in `app.json` plugins | Same — prebuild handles all of them |
| Deep links | iOS: `applinks:app.zentromeet.com`. Android: `zentromeet://oauth` (custom scheme) + `https://app.zentromeet.com/m` (App Links with `pathPrefix: /m`, `autoVerify: true`). | Prebuild regenerates `Info.plist` `CFBundleURLTypes` + `AndroidManifest.xml` `<intent-filter android:autoVerify="true">` from `app.json`. **Note:** the Android App Links use path prefix `/m` — intentionally distinct from the web app's `baseUrl: "/mobile"`. The backend at `https://app.zentromeet.com/.well-known/assetlinks.json` must serve a valid `assetlinks.json` for Android verified-link routing to succeed. |
| Google + Microsoft OAuth | Built on `expo-auth-session` + the scheme above | Works because the scheme is preserved end-to-end |
| `package-lock.json` | **Committed** (un-ignored 2026-06-15) | All workflows use `npm ci` for reproducible installs (the iOS workflow fails fast if it's missing) |
| `node_modules` git-ignored | Yes | Fresh install on every build; `$HOME/.npm` is cached |
| `android/` and `ios/` git-ignored | Yes | `npx expo prebuild --platform <p> --clean` regenerates them on every build (Android on Linux, iOS on the macOS machine) |

---

## 11. First-build checklist

1. Push `codemagic.yaml` and this doc to GitHub.
2. Connect the monorepo in the Codemagic dashboard.
3. Set **Configuration file path** to `codemagic.yaml`.
4. Add the `zentromeet_api` global env-var group (§ 3c). For iOS, also add
   the App Store Connect API key integration (`zentromeet_asc_api_key`) and
   the `app_store_credentials` group — see
   [CODEMAGIC_NATIVE_IOS_BUILD.md](CODEMAGIC_NATIVE_IOS_BUILD.md) §10.
   (`expo_credentials` / `EXPO_TOKEN` are no longer required — § 3b.)
5. (Optional for preview / required for production) upload the Android
   keystore as `zentromeet_android_keystore` (§ 3d).
6. Manually start the `android-preview` workflow from the Codemagic
   dashboard.
7. Wait ~15-25 min for the first build (cold cache: `expo prebuild`
   downloads templates, Gradle pulls dependencies). Subsequent builds
   are ~10 min once `$HOME/.npm` and `$HOME/.gradle/caches` warm up.
8. Email arrives at `support@zentromeet.com` with the artifact link.
   Download the APK.
9. Install on a phone (§ 7), run the app, smoke-test sign-in +
   appointments list.
10. Tag a `v0.3.1` release locally and push to `main`. Both
    `android-production` and `ios-production` fire automatically.

---

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **"Configuration file not found"** when starting a build | Project Settings → Build → **Configuration file path** is not set. Set it to `codemagic.yaml`. |
| **"No keystore configured"** on `android-production` | Upload a keystore via **Code signing identities** named exactly `zentromeet_android_keystore`. The workflow fails fast on purpose so you don't ship an unsigned AAB. |
| **`npm ci` fails: "package-lock.json not found"** | Expected — the lockfile is git-ignored in this project. The workflow's fallback to `npm install --no-audit --no-fund` kicks in automatically; the build continues. |
| **EAS iOS build fails with "Authentication required"** | `EXPO_TOKEN` is missing or revoked. Regenerate at `expo.dev` → Account → Access Tokens. Expo tokens are NOT action-scoped — they inherit the minting account's full permissions, so there is no scope checkbox to toggle. If the account itself lacks build permission on the project, add it via `expo.dev` → Organization → Members. If Apple credentials are stale, run `npx eas-cli credentials -p ios` locally once to refresh the cached cert. |
| **"SDK location not found"** during Gradle | `expo prebuild` failed silently before Gradle ran. Open the build log artifact (`/tmp/build.log` if the workflow saved it) and look for the prebuild error. Often a network blip — re-run the build. |
| **"Could not find a production build in the .next directory"** | Unrelated — that's the `scheduling-saas` backend on a different EC2. Ignore in this context. |
| **APK installs but crashes on launch** | The `zentromeet_api` group is missing `EXPO_PUBLIC_API_BASE_URL` (or it was misnamed `API_BASE_URL`). Expo only inlines `EXPO_PUBLIC_*` vars into the JS bundle, so a missing or wrongly-named var leaves the bundled URL as `undefined`. Set `EXPO_PUBLIC_API_BASE_URL = https://app.zentromeet.com` in the group and rebuild. Smoke-test the backend: `curl https://app.zentromeet.com/api/health`. |
| **iOS `.ipa` download step fails** | `eas-cli build --json` produced empty/malformed JSON (rare). Inspect `/tmp/eas-build.log` and `/tmp/eas-build.json` artifacts. If `EXPO_TOKEN` was revoked mid-build, regenerate it at expo.dev and re-run. |
| **Build OOM-killed** during Gradle | Rare on `linux_x64` (4 GB RAM), but possible with the New Architecture. Bump `instance_type` to `linux_x64_large` in the workflow YAML, or set `org.gradle.jvmargs=-Xmx3g` in `android/gradle.properties` (regenerate via prebuild). |
| **`expo prebuild` regenerates files that drift from local** | Expected. The `android/` and `ios/` folders are git-ignored — Codemagic always rebuilds them from `app.json`. If you've manually edited a native file locally, port the change to an Expo config plugin instead. |

---

## 13. Relationship to EAS

**Codemagic is now the build system for both platforms** — Android (Gradle)
and iOS (native Xcode). EAS is no longer in the CI path.

- **Codemagic** = all CI builds. Android APK/AAB via `expo prebuild` + Gradle;
  iOS signed App Store IPA via `expo prebuild` + CocoaPods + Xcode archive, with
  flag-gated TestFlight upload through `app-store-connect publish`. Downloadable
  artifacts, QR code, email — one dashboard, both platforms.

- **EAS** = OPTIONAL manual/laptop fallback only. The `mobile/package.json`
  `build:*` / `submit:*` scripts still call `eas-cli` (and `eas.json` is kept
  for them), but **no Codemagic workflow uses EAS**. Reach for it only if you
  want to build off-CI from a laptop.

The `ios-production` workflow **compiles iOS itself** on a `mac_mini_m2` — it no
longer queues an EAS build. See
[CODEMAGIC_NATIVE_IOS_BUILD.md](CODEMAGIC_NATIVE_IOS_BUILD.md).

---

## 14. Quick reference card

```bash
# Trigger android-preview by pushing to develop:
git checkout develop && git push

# Trigger android-production + ios-production by pushing to main:
git checkout main && git push

# Manual trigger: Codemagic dashboard → Start new build → pick workflow

# Install APK from email link via ADB:
adb install -r ~/Downloads/app-release.apk

# Stream Android device logs filtered to our app:
adb logcat | grep -i zentromeet

# Submit iOS build manually after Codemagic finishes ios-production:
cd mobile
npx eas-cli submit --platform ios --latest --profile production

# Check whether an EAS iOS build is queued / building / finished:
npx eas-cli build:list --platform ios --limit 5

# Force a fresh credentials sync if EAS auth feels stale:
npx eas-cli credentials
```

# ZentroMeet Mobile — Codemagic Android Build Guide

Remote Android builds via Codemagic CI/CD. Push to GitHub → Codemagic
builds → download APK → install on phone. No local Android SDK needed.

> Companion to `docs/BETA_RELEASE.md` (EAS store builds + TestFlight).
> Use **this guide** when you want a quick APK on your phone.
> Use **BETA_RELEASE.md** when submitting to Play Store or TestFlight.

> **⚠️ UPDATE 2026-06-16 — EAS no longer performs the store builds; both platforms build NATIVELY on Codemagic.**
> iOS now compiles on a Codemagic macOS `mac_mini_m2` (`expo prebuild` → Xcode
> archive → App Store IPA → TestFlight via `app-store-connect publish`) with no
> EAS and no `EXPO_TOKEN`; Android builds a signed AAB via `expo prebuild` +
> Gradle on Codemagic. Statements below that call EAS "the authoritative build
> system" are superseded — EAS (`eas build`/`eas submit`) is retained ONLY as an
> optional manual/laptop fallback (`npm run build:*` / `submit:*`). See
> [CODEMAGIC_NATIVE_IOS_BUILD.md](CODEMAGIC_NATIVE_IOS_BUILD.md).

---

## Architecture overview

```
GitHub push / tag
      │
      ▼
 Codemagic (Linux CI)
      │
      ├── npm install
      ├── npx expo prebuild --platform android --clean
      │       (generates android/ native project from app.json)
      ├── ./gradlew assembleRelease  ← Preview APK workflow
      │         OR
      └── ./gradlew bundleRelease   ← Production AAB workflow
              │
              ▼
         Artifact published
         (download link in Codemagic dashboard + email)
```

EAS is **not replaced** — it remains the authoritative build system for
actual Play Store and TestFlight submissions (`docs/BETA_RELEASE.md`).
Codemagic adds a fast, no-local-tooling path for getting an APK onto a
phone during development and internal testing.

---

## One-time setup (do this once)

### 1. Connect your GitHub repository

> **Monorepo note:** `mobile/` lives inside the larger
> `zentroslots` repo (which also holds the scheduling-saas backend at the root).
> Follow the monorepo path below.

1. Go to [codemagic.io](https://codemagic.io) and sign in (GitHub OAuth).
2. Click **Add application**.
3. Select **GitHub** → find the root repo (e.g. `ZentroBizProduction` or
   whatever the GitHub repo is named).
4. Choose **React Native App** as the project type.
5. **Critical — set the configuration file path:**
   In Codemagic project **Settings → Build → Configuration file path**, enter:
   ```
   codemagic.yaml
   ```
   This tells Codemagic where the YAML lives inside the monorepo.
6. The `working_directory: mobile` already set in each workflow
   ensures all build scripts (`npm install`, `expo prebuild`, `gradlew`)
   run from the correct subdirectory automatically.

### 2. Add EXPO_TOKEN

The build uses your Expo access token to authenticate the `expo prebuild`
step. Without it, prebuild still works for most cases, but having it
avoids credential prompts.

1. Go to [expo.dev](https://expo.dev) → your account → **Access Tokens**.
2. Create a token named `codemagic-ci`.
3. In Codemagic: **Teams → Global environment variables → + Add group**.
4. Group name: `expo_credentials` (must match the name in `codemagic.yaml`).
5. Add variable: `EXPO_TOKEN` = `<your token>` → mark as **secret**.

### 3. Upload your Android keystore (for signed builds)

**Preview APK (testing)**
: The workflow falls back to a debug APK automatically if no keystore is
  configured. Debug APKs are fully installable for testing — skip this
  step to get started quickly.

**Signed release APK or production AAB (required for Play Store)**
: 1. In Codemagic: **Teams → Code signing identities → Android keystores**.
  2. Click **+ Upload a keystore**.
  3. Upload your `release.keystore` file, enter:
     - **Reference name**: `zentromeet_android_keystore`
       (must match the name in `codemagic.yaml` → `android_signing`)
     - Keystore password, key alias, key password.
  4. Codemagic securely stores the keystore and injects `CM_KEYSTORE_PATH`,
     `CM_KEYSTORE_PASSWORD`, `CM_KEY_ALIAS`, `CM_KEY_PASSWORD` at build time.

> **Don't have a keystore yet?**
> Generate one with:
> ```bash
> keytool -genkey -v \
>   -keystore release.keystore \
>   -alias zentromeet \
>   -keyalg RSA \
>   -keysize 2048 \
>   -validity 10000
> ```
> Store the keystore + passwords in a password manager — losing the
> production keystore means you cannot update the Play Store listing.

---

## Triggering builds

### Automatic triggers

| Workflow | Triggers on |
|---|---|
| `android-preview-apk` | Push to `main`, `develop`, `release/*` branches + PRs to `main` |
| `android-production-aab` | Git tags matching `v*` (e.g. `v0.3.0`) |

### Manual trigger

1. Codemagic dashboard → your app → **Start new build**.
2. Select workflow: **Android Preview — Installable APK** or
   **Android Production — Play Store AAB**.
3. Select branch.
4. Click **Start build**.

### Branch-based trigger (pushing)

```bash
# Triggers android-preview-apk workflow automatically:
git push origin main

# Triggers android-production-aab workflow automatically:
git tag v0.3.0
git push origin v0.3.0
```

---

## Downloading the APK

After a successful `android-preview-apk` build:

1. Codemagic dashboard → your app → click the completed build.
2. Scroll to **Artifacts** section.
3. Click **app-release.apk** (or `app-debug.apk` if no keystore was set).
4. Download directly or scan the QR code Codemagic shows.
5. You also receive an email with a download link.

> **Build not in Artifacts?**
> Check the build logs for Gradle errors. The most common causes:
> - Missing keystore (production workflow only — preview auto-falls-back to debug)
> - Expo prebuild generated incompatible native code (check Node/Java version)
> - Gradle ran out of memory (GRADLE_OPTS is already tuned, but check logs)

---

## Installing the APK on your Android phone

### Step 1 — Enable unknown sources

On **Android 8+** (Oreo and later):

1. Settings → Apps → Special app access → Install unknown apps.
2. Find the browser or file manager you'll use to open the APK.
3. Toggle **Allow from this source**.

On older Android (pre-8): Settings → Security → Unknown sources.

### Step 2 — Download and install

**Option A — Direct download on phone**
1. Open the Codemagic artifact link on your phone's browser (Chrome works best).
2. Tap **Download**.
3. Once downloaded, open the notification → tap **Install**.

**Option B — ADB sideload (from your computer)**
```bash
# Enable Developer Options + USB Debugging on your phone first.
adb install -r path/to/app-release.apk
```

**Option C — QR code**
Codemagic shows a QR code next to each artifact. Scan it with your
phone's camera → opens the download link.

### Step 3 — Launch

Find **ZentroMeet** in your app drawer. The icon is the same as the
production app. If you have both installed, the package ID
(`com.zentromeet.app`) is the same, so installing this APK will
**replace** any existing version.

---

## Workflow reference

### `android-preview-apk`

| Setting | Value |
|---|---|
| Instance | `linux_x64` |
| Node | 20.17.0 |
| Java | 17 |
| Max duration | 60 min |
| Build command | `./gradlew assembleRelease` (signed) or `assembleDebug` (no keystore) |
| Artifact | `android/app/build/outputs/apk/**/*.apk` |
| TypeScript check | Non-blocking (pre-existing errors allowed) |
| Cancels previous | Yes (fast commits don't pile up) |

### `android-production-aab`

| Setting | Value |
|---|---|
| Instance | `linux_x64` |
| Node | 20.17.0 |
| Java | 17 |
| Max duration | 90 min |
| Build command | `./gradlew bundleRelease` (signed — **keystore required**) |
| Artifact | `android/app/build/outputs/bundle/release/*.aab` + `mapping.txt` |
| TypeScript check | Strict — build fails on new errors |
| Cancels previous | No (production builds are not cancelled mid-run) |
| Trigger | Git tags matching `v*` only |

---

## Environment variables reference

All variables are set in the Codemagic UI under **Teams → Global
environment variables** or **Workflow environment variables**.

### Group: `expo_credentials`

| Variable | Description | Secret |
|---|---|---|
| `EXPO_TOKEN` | Expo access token from expo.dev → Access Tokens | ✅ Yes |

### Group: `android_signing` (via Code Signing UI)

Codemagic injects these automatically from the uploaded keystore:

| Variable | Description |
|---|---|
| `CM_KEYSTORE_PATH` | Path to decoded `.keystore` file on CI machine |
| `CM_KEYSTORE_PASSWORD` | Keystore password |
| `CM_KEY_ALIAS` | Key alias within the keystore |
| `CM_KEY_PASSWORD` | Key password |

### Workflow `vars` (already in `codemagic.yaml` — no action needed)

| Variable | Value | Purpose |
|---|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | `https://app.zentromeet.com` | Matches eas.json preview env |
| `GRADLE_OPTS` | `-Xmx4096m ...` | Prevents Gradle OOM on CI |
| `EXPO_NO_TELEMETRY` | `1` | Suppresses Expo CLI telemetry in CI logs |

---

## versionCode handling

The `android.versionCode` in `app.json` is currently `3`.

- **Preview APK**: versionCode comes from `app.json` directly. You don't
  need to bump it for every preview build — Android allows reinstalling
  the same versionCode from a local APK.

- **Production AAB** (Play Store submission): Play Store rejects duplicate
  versionCodes. Two paths:
  1. **EAS (recommended)**: use `eas build --profile production --platform android`
     — the `autoIncrement: true` in `eas.json` bumps versionCode automatically
     on EAS servers. See `docs/BETA_RELEASE.md`.
  2. **Codemagic**: manually increment `android.versionCode` in `app.json`
     before pushing the `v*` tag that triggers the production workflow.

---

## Build matrix / signing variants

| Workflow | Keystore configured? | Gradle task | Output |
|---|---|---|---|
| `android-preview-apk` | ✅ Yes | `assembleRelease` | Signed APK (installable + matches production key) |
| `android-preview-apk` | ❌ No | `assembleDebug` | Debug APK (installable for testing) |
| `android-production-aab` | ✅ Yes | `bundleRelease` | Signed AAB (Play Store ready) |
| `android-production-aab` | ❌ No | Build aborts ⛔ | — (fail-fast before Gradle) |

---

## Troubleshooting

### "Keystore was tampered with, or password was incorrect"

The keystore reference name in `codemagic.yaml` (`zentromeet_android_keystore`)
must exactly match the name you used when uploading in Codemagic UI →
Code Signing. Check for typos. Also verify the password entered in the
UI matches the keystore's actual password.

### "SDK location not found" or Android SDK errors

Codemagic's Linux machines have Android SDK pre-installed. If you see
this error it usually means `expo prebuild` failed silently before Gradle
ran. Check the **Expo Prebuild** step logs for errors.

### "Could not determine Java version from '21.x.x'"

The workflow pins Java 17 (`java: 17` in `codemagic.yaml`). If Codemagic
defaults to a different JDK, check that your app's Codemagic team settings
don't override the Java version. React Native 0.76 requires Java 17.

### "`expo prebuild` asks for EAS login"

Add `EXPO_TOKEN` to the `expo_credentials` group in Codemagic. If you
don't have EAS set up on this project yet, run `npx eas-cli init` locally
first — it writes `extra.eas.projectId` into `app.json` and the `owner`
field, which prebuild needs.

### Gradle runs out of memory (SIGKILL during build)

`GRADLE_OPTS` is already set to 4 GB heap. If you're on a plan with less
RAM, reduce to `-Xmx2048m`. Check the build log for `Expiring Daemon
because JVM heap space is exhausted` or `SIGKILL` lines.

### "The following files have untracked changes" during prebuild

`expo prebuild --clean` regenerates `android/` each time. If the Codemagic
workspace has stale files from a previous build, `--clean` handles it.
This warning is usually cosmetic.

### APK installs but app crashes immediately

1. Check that `EXPO_PUBLIC_API_BASE_URL` matches your backend URL.
2. Verify the backend smoke passes: `curl https://app.zentromeet.com/api/health`
3. Check `pm2 logs scheduling-saas --lines 50` on EC2 for errors.
4. If a new Expo plugin was added, make sure `expo prebuild` picked it up
   (check the build log for "Running prebuild").

### Build takes more than 30 minutes

First builds are slow (~20–40 min on a cold Gradle cache). Subsequent
builds with a warm cache (`$HOME/.gradle/caches`) take ~10–15 min. If
builds consistently exceed 45 min, open a Codemagic support ticket — the
`linux_x64` instance has enough resources for RN 0.76.

### "Package com.zentromeet.app conflicts with an existing package"

If you have a Play-Store-installed version of ZentroMeet on the test
device, the signatures may differ (debug key vs Play Store key). Uninstall
the existing app first: `adb uninstall com.zentromeet.app`, then install
the APK.

---

## Relationship to EAS

| Task | Use |
|---|---|
| Quick APK for phone testing | **Codemagic** (`android-preview-apk` workflow) |
| TestFlight (iOS) | **EAS** (`eas build + eas submit`, see `docs/BETA_RELEASE.md`) |
| Play Store submission (AAB) | **EAS** (`eas build --profile production`) — autoIncrement handles versionCode |
| Local dev builds | **EAS** (`eas build --profile development --platform android`) |
| Codemagic production AAB | Use only when EAS remote queue is unavailable or for artifact archiving |

---

## Quick reference card

```bash
# Trigger a preview APK build (push to main):
git push origin main

# Trigger a production AAB build (tag):
git tag v0.3.1
git push origin v0.3.1

# Manual build: Codemagic dashboard → Start new build

# Download APK: Dashboard → completed build → Artifacts → app-release.apk
# Or check your email for the download link.

# Install via ADB:
adb install -r ~/Downloads/app-release.apk

# Check device logs after install:
adb logcat | grep -i zentromeet
```

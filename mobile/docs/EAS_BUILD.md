# ZentroMeet Mobile — EAS Build & Distribute

Cloud-hosted Expo builds so you can install + test the mobile app on a real device **without running Expo on your PC**. Everything runs on Expo's build servers; you get a hosted install link + QR code at the end.

---

## TL;DR — Build a preview APK in 5 commands

From `mobile/`, run these in order (one-time setup → subsequent rebuilds are just step 5):

```bash
# 0. Install dependencies + create placeholder assets (first time only)
npm install --legacy-peer-deps
npm run assets:generate

# 1. Log into your Expo account (opens a browser; free account works)
npm run eas:login

# 2. Link this project to your Expo account
#    → writes `owner` + `extra.eas.projectId` into app.json
npm run eas:init

# 3. Build an installable Android APK in the cloud (~10-15 min)
npm run build:android:preview
```

When the build finishes EAS prints a hosted URL + QR code. Open the URL on your Android phone (or scan the QR) → tap **Install** → done. The app uses **production API** (`https://app.zentromeet.com`) by default.

---

## What's already set up

| Piece | Status | Notes |
|---|---|---|
| `app.json` identifiers | ✅ `com.zentromeet.app` | Both iOS bundle ID + Android package |
| Deep-link scheme | ✅ `zentromeet://` | OAuth callback handler at `zentromeet://oauth/*` |
| Universal links (iOS) | ✅ `applinks:app.zentromeet.com` | Apple App Site Association — needs server entry too |
| Android intent filters | ✅ | OAuth scheme + `https://app.zentromeet.com/m/*` deep links |
| Permissions | ✅ | `INTERNET`, `POST_NOTIFICATIONS`, `VIBRATE`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED` |
| `expo-notifications` plugin | ✅ | Channel `default`, icon `assets/notification-icon.png`, color `#359df3` |
| Splash + adaptive icon | ✅ | Placeholder branded PNGs in `assets/` (swap for real later) |
| `eas.json` profiles | ✅ | `development`, `preview`, `production` |
| Hardcoded API URL | ✅ | `https://app.zentromeet.com` baked into every profile's `env` |
| Push notification backend | ✅ | Migration 0069 deployed; `/api/mobile/push-tokens` live |

---

## Build profiles

| Profile | Output | Distribution | Use when |
|---|---|---|---|
| **`development`** | Android: debug APK with dev-client; iOS: simulator build | internal | You want hot reload + Metro on a real device |
| **`preview`** | Android: release APK; iOS: signed .ipa | internal | **Real-device QA without a PC** — the default for sharing |
| **`production`** | Android: .aab; iOS: store-ready .ipa | store | Submitting to Play Store / TestFlight |

The CLI commands map 1:1:

```bash
npm run build:dev:android          # development profile
npm run build:android:preview      # preview profile  ← most common
npm run build:ios:preview          # preview profile, iOS
npm run build:android:production   # production profile
npm run build:ios:production       # production profile, iOS
```

---

## First-time setup (full walkthrough)

### Step 1 — Create / log into an Expo account

You need a free Expo account (https://expo.dev/signup). From the project root:

```bash
npm run eas:login
```

The CLI opens a browser to authenticate. After login:

```bash
npm run eas:whoami    # confirms you're signed in
```

### Step 2 — Link this project to Expo

```bash
npm run eas:init
```

This prompts to create a new Expo project (or pick an existing one). The CLI:
- Writes `extra.eas.projectId` into `app.json` (a UUID)
- Writes `owner` into `app.json` (your Expo username)
- Reserves the project on Expo's servers

**Commit both changes** — they need to be in git so collaborators / CI use the same project.

### Step 3 — Build a preview APK

```bash
npm run build:android:preview
```

The CLI uploads your source (excluding `node_modules`, `.env`, `ios/`, `android/`) to Expo's build server. Build takes 10–15 minutes. While it runs you can:
- Close your terminal — the build is server-side
- Track progress at `https://expo.dev/accounts/<owner>/projects/zentromeet-mobile/builds`

When it finishes you get **two things**:
1. **Hosted APK URL** like `https://expo.dev/artifacts/eas/<id>.apk`
2. **Install QR code** that opens an Expo-hosted install page

### Step 4 — Install on your Android phone

**Option A — Tap the URL**
- Open the link on your phone
- Tap "Install" (you'll need to allow installs from this source the first time)

**Option B — Scan the QR**
- Use the phone's camera on the QR code in the build summary
- Tap the resulting URL → Install

**Option C — Share with testers**
- Forward the hosted URL via Slack, SMS, email
- Anyone with the link can install (it's an EAS internal distribution URL — not public Play Store)

### Step 5 — iOS preview (optional, more setup)

iOS preview is **also wireless install**, but Apple requires registering each device's UDID first:

```bash
npx eas-cli device:create
# Walks you through registering your iPhone's UDID via a QR scan
# Run once per device you want to install on.

npm run build:ios:preview
```

After the build, you get the same hosted URL + QR. Open on iPhone → Safari prompts to install. Settings → General → Profiles → Trust the developer certificate the first time.

---

## Re-builds and updates

You have two ways to ship new code to testers:

### A. Rebuild from scratch (changes native code, deps, or `app.json`)
```bash
npm run build:android:preview
```
~12-min wait, new APK URL each time. Testers reinstall.

### B. Over-the-air JS update (only JS/TS code changed)
Configure EAS Update once:
```bash
npx eas-cli update:configure
# Writes `updates.url` + `runtimeVersion` into app.json
```
Then ship a JS-only update:
```bash
npx eas-cli update --channel preview --message "Fix booking detail crash"
```
Testers get the update on the next app launch — no reinstall needed. Caveat: only safe for code that doesn't touch native modules / dependencies.

---

## Sharing builds with testers

The internal distribution URL EAS hands back works as a wireless install link for anyone you give it to. There's no review / queue / approval.

To get the link any time:

```bash
npm run build:list           # shows recent builds + their URLs
```

Or visit `https://expo.dev/accounts/<owner>/projects/zentromeet-mobile/builds` directly.

For broader QA programs, EAS has a **internal test group** feature (`eas-cli build:group:create`) that lets you batch-add testers' email addresses, but for 5-10 manual testers the raw URL is simplest.

---

## Validation checklist (already verified)

- ✅ `app.json` — `bundleIdentifier`, `package`, `scheme`, intent filters, permissions
- ✅ Deep linking — `zentromeet://oauth/*` (OAuth callback), `https://app.zentromeet.com/m/*` (universal links)
- ✅ `expo-notifications` plugin block — Android channel, icon, color
- ✅ Icons — `assets/icon.png` (1024), `assets/adaptive-icon.png` (1024)
- ✅ Splash — `assets/splash.png` (1284×2778), background `#f5faff`
- ✅ EAS profile `env` blocks — production API URL baked in
- ✅ OAuth callbacks — `lib/useAuth.ts` parses `zentromeet://oauth/callback?token=...` regardless of cold-start vs foreground
- ✅ Push notifications — `usePushNotifications` hook registers token with `/api/mobile/push-tokens` (deployed) on first auth

---

## Common pitfalls

**"Project is not linked"** → run `npm run eas:init`. Re-run if you've changed Expo accounts.

**"Build failed — missing asset icon.png"** → run `npm run assets:generate` to write the placeholder PNGs. Re-run if you accidentally deleted them.

**Android build succeeds but app crashes on launch** → check the EAS build log for the bundling step. Most often a stray TypeScript error or a missing native dep — the app builds, but Metro bundle fails. Run `npm run typecheck` locally first; the 4 baseline errors in `Button.tsx`, `Card.tsx`, `usePushNotifications.ts` are known and don't block runtime.

**iOS preview build asks for an Apple Developer account** → free Apple ID works for ad-hoc preview builds. The CLI walks you through.

**OAuth callback doesn't return to the app** → confirm the backend OAuth flow is preserving the `zm_oauth_mobile=1` cookie and deep-linking to `zentromeet://oauth/callback?token=...`. This is Phase 1A backend work and is already deployed.

**Push notification token never reaches the server** → ensure `POST_NOTIFICATIONS` is granted on Android 13+ (Settings → ZentroMeet → Notifications). iOS requires user to accept the system prompt on first launch.

---

## Reference

- EAS Build docs: https://docs.expo.dev/build/introduction/
- EAS Submit docs: https://docs.expo.dev/submit/introduction/
- Internal distribution: https://docs.expo.dev/build/internal-distribution/
- OTA updates: https://docs.expo.dev/eas-update/getting-started/

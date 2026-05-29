# ZentroMeet Mobile — Beta Release Runbook

The day-of-release operational guide for shipping production builds to
TestFlight and Google Play Internal Testing.

> Companion to `docs/EAS_BUILD.md` (first-time setup) and
> `docs/WEB_DEPLOY.md` (web preview at `app.zentromeet.com/mobile`).
> This file is the **operational** runbook — what you actually run on
> release day.

---

## 0. Pre-release checklist (run this every time)

Before kicking off a production build:

- [ ] All Phase 4 telemetry, onboarding, and account-deletion changes
      are deployed to the web preview and verified there
      (`https://app.zentromeet.com/mobile/`).
- [ ] `npx tsc --noEmit` is clean (or only carries the four documented
      pre-existing errors in `Button.tsx`, `Card.tsx`,
      `usePushNotifications.ts`, and `appointments/[id]/index.tsx`).
- [ ] `app.json` `version` reflects what testers should see (display
      string only — EAS owns versionCode/buildNumber via
      `appVersionSource: "remote"` + `autoIncrement: true`).
- [ ] Backend smoke is green:
      `curl -s https://app.zentromeet.com/api/health | jq '.ok, .version'`
      returns `true` and the expected version.
- [ ] Telemetry sink end-to-end:
      ```bash
      curl -s -X POST https://app.zentromeet.com/api/mobile/telemetry \
        -H "Content-Type: application/json" \
        -d '{"events":[{"ts":1700000000000,"kind":"info","severity":"info","label":"release-check"}]}'
      ```
      Should return `{"ok":true,"received":1}`.
- [ ] You have an active EAS session: `eas whoami` returns the
      ZentroMeet org account.

If any item fails, **do not build**. Fix it on the web preview first.

---

## 1. Shipping iOS to TestFlight

### Build

From `mobile/`:

```bash
# Production .ipa, signed with the App Store distribution certificate.
# autoIncrement bumps buildNumber server-side — you don't touch
# app.json's ios.buildNumber for this.
eas build --platform ios --profile production
```

You'll be prompted for:
- Apple ID credentials (cached after first run)
- App Store Connect API key (cached after first run)
- Provisioning profile choice (let EAS manage it the first time)

Build runs ~20-30 min in EAS's queue. Email arrives when it's ready
with a download URL. The .ipa is also stored in your EAS dashboard.

### Submit to TestFlight

```bash
# Uploads the most recent production build to App Store Connect →
# TestFlight processing queue. Apple's notarisation typically takes
# 10-30 min after upload completes.
eas submit --platform ios --latest --profile production
```

You'll be asked for `ascAppId` the first time — find it in App Store
Connect → My Apps → ZentroMeet → App Information → Apple ID.

### Add testers in App Store Connect

1. App Store Connect → ZentroMeet → TestFlight → **Internal Testing**
   (Apple-employee/team accounts) or **External Testing** (up to 10,000
   testers, requires beta-review on first build of a version string).
2. Click your group → Add Testers by email.
3. Each tester gets a TestFlight invite email with a redemption code.

### What testers do

1. Install **TestFlight** from the App Store (one-time).
2. Open the invite email on their iPhone, tap **View in TestFlight**.
3. Tap **Accept** then **Install**.
4. Launch ZentroMeet from the TestFlight-branded icon.

---

## 2. Shipping Android to Google Play Internal Testing

### Build

```bash
# Production .aab (Android App Bundle, what Play Store wants).
eas build --platform android --profile production
```

Build runs ~15-25 min. You'll need the Play Service Account JSON the
first time (Google Cloud Console → IAM → service account → keys →
download JSON). EAS caches it.

### Submit to Play Internal Testing

```bash
# Track defaults to "internal" + status "draft" per eas.json
# submit.production.android config.
eas submit --platform android --latest --profile production
```

The `draft` release status means it lands in Play Console but isn't
auto-promoted to testers. Go to **Play Console → ZentroMeet →
Internal testing → Releases**, click the new draft, click **Review
release**, then **Start rollout to Internal testing**.

### Add testers in Play Console

1. **Play Console → ZentroMeet → Internal testing → Testers** tab.
2. Create or pick a tester list (Google Group or comma-separated email
   list, max 100 testers per list).
3. Click **Copy link** to get the opt-in URL.
4. Send the opt-in URL to testers — they must accept BEFORE installing.

### What testers do

1. Click the opt-in URL → sign in with their Google account → tap
   **Become a tester**.
2. Open the link in the same message that says **Download it on Google
   Play** (or search "ZentroMeet" in Play Store while signed in with
   the same account).
3. Install. The Play Store will show "Internal testing" under the app
   name so they know which channel they're on.

---

## 3. Release checklist (paste into the release PR / issue)

```
## Pre-release
- [ ] Web preview verified at https://app.zentromeet.com/mobile/
- [ ] tsc --noEmit clean (modulo documented pre-existing errors)
- [ ] /api/health 200 with current version
- [ ] /api/mobile/telemetry returns 200 with sample batch
- [ ] eas whoami matches expected account
- [ ] app.json version bumped + committed

## iOS (TestFlight)
- [ ] eas build --platform ios --profile production succeeded
- [ ] eas submit --platform ios --latest --profile production succeeded
- [ ] TestFlight processing completed (App Store Connect email)
- [ ] Internal testers can install + launch
- [ ] Smoke test on installed build:
  - [ ] Login flow (email + Google OAuth)
  - [ ] Onboarding completes (3 steps)
  - [ ] Push permission prompt shows
  - [ ] Tab navigation works
  - [ ] Pull-to-refresh on Appointments
  - [ ] FAB → quick-create → confirm a test booking
  - [ ] Settings → Profile edit (save + return)
  - [ ] Settings → Calendar (Google OAuth round-trip)
  - [ ] Settings → Security → Active sessions list loads

## Android (Play Internal Testing)
- [ ] eas build --platform android --profile production succeeded
- [ ] eas submit --platform android --latest --profile production succeeded
- [ ] Play Console review-and-rollout completed
- [ ] Tester opt-in URL distributed
- [ ] Same smoke test as iOS above

## Post-release
- [ ] Backend pm2 logs show mobile_telemetry events from new build
      (`pm2 logs scheduling-saas | grep mobile_telemetry | grep "appVersion.*0.3.0"`)
- [ ] No spike in 4xx/5xx on /api/auth/* or /api/mobile/telemetry
- [ ] Tester feedback channel monitored for first 24h
```

---

## 4. Rollback

Mobile rollbacks are **not** symmetric with the web — once a binary is
installed on a tester's device, you can't pull it back. The
recoverable paths are:

### A. New build hasn't been promoted yet (still in draft / TestFlight processing)

Easy case. Just delete the bad build:

- **iOS**: App Store Connect → TestFlight → expire the build (click
  the build, **Expire Build**).
- **Android**: Play Console → Internal testing → click the bad
  release → **Halt rollout**.

### B. New build is already in testers' hands

You **cannot** uninstall remotely. Three things to do, in order:

1. **Halt distribution** so no new testers get the bad build (Apple:
   expire build; Google: halt rollout).
2. **Ship a hotfix build** with `eas build --platform <p> --profile
   production` and increment the EAS-side version. Same submit flow.
   Apple takes ~30 min, Google takes ~1-3 hours to propagate.
3. **Tell testers**:
   - iOS: "Open TestFlight, tap ZentroMeet, tap Install Latest."
   - Android: "Open Play Store, search ZentroMeet, install update.
     If updates don't auto-pull, force-quit Play Store and retry."

### C. Backend regression that breaks the mobile app

Mobile binary is fine, the backend is bad. **Don't rebuild mobile** —
roll the backend back instead.

```bash
# On scheduling-saas EC2:
ssh -i ~/.ssh/AATSKeyPair.pem ubuntu@35.83.95.42
cd /var/www/scheduling-saas
git log --oneline -5             # find the last good commit
git reset --hard <good-sha>
npm run build > /tmp/build.log 2>&1
pm2 restart scheduling-saas --update-env
```

The mobile app uses relative-domain calls, so a backend rollback fully
restores the experience without any app-side action.

---

## 5. Beta tester instructions (paste into onboarding email)

```
Hi <name>,

Thanks for helping us test ZentroMeet for mobile!

WHAT WE WANT TO LEARN
We're validating that ZentroMeet feels great as a primary tool
on your phone (not a companion). Pay extra attention to:
  • The first-launch onboarding (3 quick screens)
  • Notification reliability — do you actually get push alerts?
  • Booking creation via the + button at the bottom-right
  • Anything that feels slow, broken, or surprising

HOW TO INSTALL
  iPhone: <TestFlight invite URL>
  Android: <Play Internal Testing opt-in URL>

REPORTING ISSUES
Email <support@zentromeet.com> with:
  • What you tried to do
  • What happened instead
  • Your phone model + OS version
Screenshots are gold.

If the app crashes, just relaunch it — we capture the crash
trail automatically. You don't need to do anything special.

WHAT'S NEW IN THIS BUILD
  • Native profile editing
  • Active sessions management
  • Google + Microsoft calendar connections
  • First-run onboarding flow
  • Premium FAB + tighter calendar density
  • Backend health surfaced in Diagnostics

PRIVACY
We don't capture what you type, who you message, or anything
identifying. Crash trails are structural only (status codes,
error names, route paths). Full details:
  https://app.zentromeet.com/legal/privacy

Thank you,
The ZentroMeet team
```

---

## 6. Known limitations in beta

These are deliberate gaps you should mention in your release notes so
testers don't file them as bugs:

- **Account deletion** routes through `support@zentromeet.com` for now
  (Settings → Security → Danger zone). Self-service in-app deletion
  ships in a follow-up. Apple + Google both explicitly accept the
  mailto handoff during beta.
- **Avatar upload + SSO provider changes** still hand off to the web
  app. Multi-file upload + OAuth flows are desktop-best.
- **Brand Studio + Billing** are intentionally web-only (visual
  side-by-side preview + Stripe Checkout).
- **Email-channel notification rules** (digests, quiet hours, per-event
  templates) live on the web dashboard. Mobile only governs the
  device-level push permission.
- **Offline mutation queueing** is not wired — if a booking confirm
  fires while offline, the user gets the OfflineBanner and must retry
  manually. Reads work offline (TanStack Query persistence).
- **No iPad-optimised layout** — the app runs on iPad but uses the
  iPhone phone layout (Apple's split-view will be added post-launch).
- **No widgets, no Apple Watch, no Live Activities** — out of scope for
  the beta.

---

## 7. Operational telemetry — how to read it

The mobile app ships batched telemetry to the backend every 60s + on
AppState background. Each event lands as a structured log line.

```bash
# All mobile telemetry events from the last 100 log lines:
pm2 logs scheduling-saas --lines 100 --nostream | grep mobile_telemetry

# Errors only:
pm2 logs scheduling-saas --lines 500 --nostream | grep mobile_telemetry | grep -i error

# Filter by deviceId (when a beta tester reports an issue, ask for the
# deviceId from their Settings → Diagnostics screen):
pm2 logs scheduling-saas --lines 1000 --nostream | grep mobile_telemetry | grep "deviceId.*<id>"

# Filter by appVersion (useful after a release):
pm2 logs scheduling-saas --lines 1000 --nostream | grep mobile_telemetry | grep "appVersion.*0.3.0"
```

Each event includes:
- `kind`: `crash` | `runtime` | `network` | `mutation` | `navigation` | `info`
- `severity`: `info` | `warn` | `error`
- `label`: short human-readable description
- `detail`: optional structured payload
- `appVersion`, `platform`, `deviceId`
- `userId` + `tenantId` if a session was present at the time

The flusher has a circuit breaker: 5 consecutive failures cool the
flush interval down to 5 minutes until ONE success resets it. So
short backend outages don't spam the queue, but persistent ones do
eventually pause shipping until the backend recovers.

---

## 8. Common gotchas

- **"App rejected by App Store for missing account deletion"** — we
  fixed this in Phase 4. The Danger Zone row in Settings → Security
  opens a pre-filled mailto. Apple has explicitly accepted this
  pattern since 2022; cite guideline 5.1.1.v if you're asked.

- **"Build succeeded but TestFlight says Invalid Binary"** — usually
  expired provisioning profile or signing certificate. Run
  `eas credentials` and choose the iOS app → manage. Let EAS
  regenerate. Re-submit.

- **"Push notifications work in development but not production"** —
  production builds use the production APNs cert, which Apple
  generates separately from the development one. Run
  `eas credentials` and ensure both are present.

- **"Telemetry events not showing up in pm2 logs"** — check that the
  device actually has network connectivity (the in-device buffer
  persists across crashes, but flushing requires network), and that
  the user has spent at least 60s in the app or briefly backgrounded
  it to trigger the AppState flush.

- **"Backend deploy looks like it succeeded but the mobile app still
  hits the old code"** — `pm2 restart` isn't enough for Next.js. You
  need `npm run build` first. See main repo CLAUDE.md for the full
  deploy recipe.

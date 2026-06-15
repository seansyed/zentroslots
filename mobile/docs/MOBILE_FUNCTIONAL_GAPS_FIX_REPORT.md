# ZentroMeet Mobile — Functional Gaps Fix Report

**Date:** 2026-06-15
**Scope:** Branding/logo, signed-in profile image, Customer CRUD, Google + Microsoft calendar OAuth
**Mobile:** Expo SDK 52 / RN 0.76.9 · **Backend:** Next.js (app.zentromeet.com, repo `zentroslots`)
**Strict rules honored:** web app + web OAuth + mobile login OAuth untouched; no secrets in the mobile bundle; no WebView OAuth (system browser via `WebBrowser.openAuthSessionAsync`); reused existing prod APIs; tenant isolation preserved; archive (soft-delete) not hard-delete; no committed generated `android/ios`.

---

## 1. ZentroMeet logo (branding)

**Root cause:** there was no in-app logo — the login screen had a hard-coded 40×40 "Z" box + plain "ZentroMeet" text, and the boot screen showed only a spinner. No reusable logo component existed. The canonical brand assets live in the web app (`public/zentromeet-mark.svg`, `public/zentromeet-wordmark.svg`) but were never brought into mobile.

**Fix:**
- New `mobile/src/components/ui/Logo.tsx` — vector transcription of the official mark + wordmark via `react-native-svg` (already a dep, 15.8.0). Brand `#359df3` + ink `#0f172a`, exact match to web. Variants `mark` / `wordmark` (+ optional tagline), aspect-ratio preserved, accessible label, and a `tenantLogoUrl` override that falls back to the platform mark if the tenant image fails to load.
- Mounted on the **login screen** (`wordmark`, with tagline) and the **boot/loading screen** (`mark`).
- **Tenant vs platform branding:** kept separate. Login/boot are platform surfaces → always ZentroMeet. Tenant branding is now *available* (see below) for tenant-context surfaces; the platform logo is never substituted for a tenant's configured logo and vice-versa.

**Tenant branding (additive, web-safe):** `GET/PATCH /api/auth/me` now also returns `tenant.logoUrl` + `tenant.primaryColor` (columns already existed; web ignores the extra keys). `mobile/src/api/profile.ts` passes them through (logo URL absolutized — see §2). `primaryColor` theming is intentionally deferred (large refactor); the field is exposed for future use.

---

## 2. Signed-in profile image

**Root cause:** the backend already returns `avatarUrl`, the mobile profile API parsed it, and every screen renders it via `Avatar` (with initials fallback + cache-clear on logout). BUT the backend stores avatars as **relative paths** (`/uploads/avatars/<file>` — see `lib/auth/avatar-fetch.ts:245`). React Native's `<Image>` cannot load a relative URI, so the image silently failed and always fell back to initials.

**Fix:** `mobile/src/lib/url.ts` `absolutizeUrl()` (pure, tested) + `toAbsoluteImageUrl()` in `profile.ts` now absolutize relative URLs against `env.apiBaseUrl`. Absolute (http/https/protocol-relative) and `data:` URLs pass through untouched. Applied to **both** `avatarUrl` and tenant `logoUrl`.
- Initials fallback, broken-image handling, circular crop: already correct in `Avatar.tsx`.
- User-switch / logout safety: `authStore.signOut()` already clears persisted + in-memory query caches; avatar comes from the `Profile` query (not the session), so User A's image cannot survive into User B's session.

---

## 3. Customer management (full CRUD)

**Entity:** `customer` == `client` == `contact` — a single `customers` table. ("client" is only `bookings.clientEmail/clientName` + a user *role*; there is no separate contacts entity.) **No backend changes, no migration** — the production APIs already cover everything; mobile was simply read-only.

**Reused prod APIs:** `GET /api/customers?q=` (list), `POST /api/customers` (create; **409 on duplicate email**), `GET /api/customers/:id`, `PATCH /api/customers/:id` (update name/phone/notes/status/tags). **No hard delete exists by design — archive = `PATCH {status:"archived"}`** (preserves all booking history).

**Mobile additions:**
- `api/customers.ts`: `create`, `update`, `archive`, `unarchive`.
- `hooks/useCustomers.ts`: `useCreateCustomer`, `useUpdateCustomer`, `useArchiveCustomer`, `useUnarchiveCustomer` (invalidate list + detail on success).
- New `components/ui/CustomerEditModal.tsx`: create + edit form (name, email [create-only — backend PATCH has no email], phone, status chips, tags, notes), required-field validation, **duplicate-email warning** (maps 409 to the email field), loading + success + API-error states.
- List screen (`(tabs)/customers.tsx`): **+ FAB** to add, archived hidden by default with a "Show archived (N)" toggle, search + pull-to-refresh + empty/error states already present.
- Detail screen (`customers/[id]/index.tsx`): **Edit** + **Archive/Restore** actions in the top bar; archive behind a confirmation dialog that explains history is preserved; refetch after mutation.

**Security:** all customer endpoints are `requireUser()` + tenant-scoped (`eq(customers.tenantId, caller.tenantId)`); a customer from another tenant 404s. We **did not** change authz to `requireRole` — that would alter existing web behavior (open product decision, flagged). Server remains authoritative; no local-only records.

---

## 4–7. Calendar OAuth (Google + Microsoft) + deep links

**Root cause:** the mobile "Connect" buttons opened `…/api/calendar/{provider}/connect?mobile=1` in the system browser via `Linking.openURL`. Two failures: (a) that connect route is **cookie/session-authenticated**, but the system browser has **no ZentroMeet session** (mobile auth is a Bearer JWT, in-app only) → unusable page; (b) the calendar **callback ignored `mobile=1` and always redirected to the web dashboard** — it never returned to the app. (This is distinct from mobile *login* OAuth, which already had a mobile path.)

**Design — secure signed-state handoff (no tokens on the device, no new DB table):**
1. App (Bearer-authed) calls new `GET /api/calendar/{provider}/connect/mobile` → backend mints a **short-lived (10 min) signed state** (HS256/`JWT_SECRET`) binding `{userId, tenantId, provider, purpose}` and returns the provider consent `authUrl`.
2. App opens it with `WebBrowser.openAuthSessionAsync(authUrl, "zentromeet://oauth/calendar/{provider}")` (system browser — Google/MS block WebViews).
3. Provider redirects to the **existing** HTTPS callback `…/api/calendar/{provider}/callback?code&state`.
4. Callback detects the signed state (`verifyCalendarMobileState`), resolves user/tenant **from the token** (no cookie/session needed), exchanges the code, and **persists encrypted tokens server-side via the same `upsert{Google,Microsoft}Connection`** the web flow uses. It then deep-links `zentromeet://oauth/calendar/{provider}/success` (or `…/error?error=`) — **carrying no tokens, only a signal**.
5. App (auth session result, warm path) or the cold-start route refreshes the connection list → status flips to Connected.

**Backend changes:**
- New `lib/calendar/oauth-mobile.ts` — `mintCalendarMobileState` / `verifyCalendarMobileState` (provider-scoped, tamper-proof, expiring) + deep-link builders.
- New `app/api/calendar/{google,microsoft}/connect/mobile/route.ts` — Bearer-authed start (role-gated + integration-enabled check), returns `{ authUrl }`.
- Modified `app/api/calendar/{google,microsoft}/callback/route.ts` — added a **mobile branch gated on the signed state**, before the existing web (cookie-state) path. **Web flow is provably untouched**: a web request carries a random cookie-nonce state that is *not* a valid JWT, so `verifyCalendarMobileState` returns null and execution falls through to the unchanged web upsert + dashboard redirect.

**Mobile changes:**
- `api/calendarConnections.ts` — `mobileConnectStart(provider)`.
- `app/settings/calendar.tsx` — `openConnect` now uses the secure `WebBrowser` flow; **double-tap guarded** (`connecting` state prevents a second OAuth session); success refetches connections; cancel is a no-op; provider errors show an Alert. Removed the old racy global `Linking` listener. Disconnect/reconnect already worked and are preserved; status auto-refreshes; the user never lands on a blank web page.
- New deep-link route `app/oauth/calendar/[provider]/[status].tsx` — cold-start/background handler: refreshes the connections cache, surfaces errors, lands on Settings → Calendar. Android intent filter `host:"oauth"` (app.json) already covers `zentromeet://oauth/calendar/*`; iOS uses the `zentromeet` scheme.

**Microsoft note:** if the Azure app registration shows an "unverified publisher" consent warning, that is an Azure app-registration/branding setting (publisher verification), independent of this code.

---

## Security review

- **No secrets in the mobile bundle** — no OAuth client secret/redirect logic on the device; the app only ever receives a provider `authUrl` + opens it.
- **No tokens in deep links** — provider access/refresh tokens go straight into `calendar_connections` (AES-GCM at rest). Deep links carry only success/error.
- **State integrity** — signed (HS256/`JWT_SECRET`), 10-min TTL, bound to user+tenant+provider; a google state cannot be replayed as microsoft (test-covered); tampered/foreign/empty states rejected.
- **Tenant isolation** — calendar connection attributed to the token's tenant; customer + profile endpoints all tenant-scoped via `requireUser`.
- **Web safety** — web calendar OAuth + mobile login OAuth + web login untouched (mobile paths are additive and gated).

## Tests
- Backend `tests/calendar-oauth-mobile.test.ts` (6): state round-trip, cross-provider replay rejected, tamper rejected, garbage/empty rejected, foreign-secret rejected, deep links carry no tokens.
- Mobile `tests/url.test.ts` (6): relative→absolute, leading-slash, absolute/protocol-relative/data untouched, null→null, trailing-slash base.
- Existing mobile `safeInit`/`polyfills` (10) still green. **22/22 pass.**

## Builds / validation
- `tsc --noEmit`: mobile **clean**, backend **clean**.
- expo-doctor / expo export (android+ios) / expo prebuild / web production build: see final response.

## Remaining / deferred
- **Backend deploy required** for calendar OAuth + tenant-branding (`/api/auth/me`) to take effect (mobile already ships the client side).
- **Device QA** (real Google/MS consent → Connected) — operator step; OAuth is NOT marked "fixed" until the real consent page returns to the installed app.
- Deferred (non-blocking): tenant `primaryColor` theming; customer list pagination (currently backend `limit(200)`); store-ready raster app icons from the SVGs.
- Provider console: confirm `https://app.zentromeet.com/api/calendar/{google,microsoft}/callback` is whitelisted (already is if web calendar OAuth works — the mobile flow reuses the same HTTPS callback; no new provider redirect URI needed).

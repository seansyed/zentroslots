# Google Analytics 4 — ZentroMeet integration

**Status:** production. Loaded globally on both surfaces:

- `zentromeet.com` (public marketing)
- `app.zentromeet.com` (authenticated app shell)

Both surfaces are served by this same Next.js process, so a single
mount in `app/layout.tsx` covers everything.

## Measurement ID

The Measurement ID is read from the env var
`NEXT_PUBLIC_GA_MEASUREMENT_ID` at runtime.

> Why `NEXT_PUBLIC_*` and not `VITE_*`? This app is Next.js 15. Next
> inlines client-bundle env vars under the `NEXT_PUBLIC_` prefix at
> build time; a `VITE_*` name would resolve to `undefined` on the
> client and silently disable GA4.

Production value: `G-ZD40BSLJRY` (added to `.env` on the EC2 host —
see CLAUDE.md for the deploy recipe).

When the env var is **unset** or **wrong shape**, the GAProvider
renders nothing, no `<script>` is injected, no events fire, no
network calls happen. This is the safe default for local dev.

Format guard: `/^G-[A-Z0-9]{6,}$/`. A typo like `g-zd40bsljry` or
`GA-ZD40BSLJRY` short-circuits as if unset.

## Architecture

```
app/layout.tsx
   └─ <GAProvider />                       (mounted once at the root)
       ├─ <Script id="ga4-init"> ────────  inline gtag stub + privacy
       │                                   defaults + initial config
       │                                   (anonymize_ip, no Google
       │                                   signals, no ad personalization,
       │                                   send_page_view=false,
       │                                   transport_type=beacon)
       ├─ <Script id="ga4-loader"> ──────  https://www.googletagmanager.com/gtag/js
       └─ <Suspense><GATracker /></Suspense>
              ├─ usePathname + useSearchParams → page_view on every change
              └─ ?ga_event=<name>      → fires the typed event then strips
                                         the param from the URL via
                                         router.replace({ scroll: false })
```

### Files

| File | Role |
| --- | --- |
| `lib/analytics/ga4/types.ts` | Typed contracts: `GA4EventName` union, `GA4EventParams` (no-PII shape), `GtagFn`. |
| `lib/analytics/ga4/client.ts` | `getMeasurementId()`, `isGAEnabled()`, `initializeGA()`, `trackPageView()`, `trackEvent()`, `ALL_GA4_EVENT_NAMES`. SSR-safe via `typeof window` guards. |
| `components/analytics/GAProvider.tsx` | Mounts the gtag scripts + the SPA route tracker + the URL-param event dispatcher. |
| `components/analytics/BookingCompletedTracker.tsx` | Fires `booking_completed` from the paid-flow confirmation page. |
| `tests/ga4-client.test.ts` | Unit tests for env validation, gtag call shape, param sanitation. |

> The `lib/analytics/ga4/` namespace is deliberately separate from
> the existing `lib/analytics/` directory (which holds server-side
> aggregation modules: revenueMetrics, staffingInsights, etc.). The
> two layers never interact at runtime.

## Event catalogue

All event names are constrained by the `GA4EventName` union — a typo
at the call site is a TypeScript error. The full enum:

| Event | Fired when | Params |
| --- | --- | --- |
| `signup_started` | Visitor switches the login form to signup mode. | – |
| `signup_completed` | New workspace created via email/password OR new OAuth identity created via Google/Microsoft. | `provider` ("google" \| "microsoft" — OAuth path only) |
| `demo_requested` | (Reserved.) Visitor submits the `/api/public/demo` form. The endpoint exists; the client form is not yet built. See the maintainer TODO in `app/api/public/demo/route.ts`. | – |
| `booking_completed` | Free booking → fires inline from `BookingFlow` once the booking is created. Paid booking → fires from `/booking/confirmed` after the Stripe success redirect. | `value_bucket` ("free" \| "paid"), `service_name`, `tenant_slug` |
| `stripe_checkout_started` | User clicks a paid-plan CTA in `BillingActions`, just before the browser leaves for the Stripe-hosted checkout page. | `plan`, `interval` |
| `subscription_started` | Stripe redirects the user back to `/dashboard/billing?status=success&ga_event=subscription_started` after a successful subscription checkout. | `plan`, `interval` |
| `calendar_connected` | (Reserved.) For non-OAuth calendar attachments (ICS subscription feeds). | `provider` |
| `google_connected` | Google calendar OAuth callback succeeds. | `provider` ("google") |
| `microsoft_connected` | Microsoft calendar OAuth callback succeeds. | `provider` ("microsoft") |

### Parameter contract

The `GA4EventParams` type at `lib/analytics/ga4/types.ts` is the
enforced contract. **Allowed fields only:**

- `service_name` — categorical bucket key, no PII
- `plan` — `"free" | "solo" | "pro" | "team" | "enterprise"`
- `interval` — `"month" | "year"`
- `provider` — `"google" | "microsoft"`
- `tenant_slug` — already-public slug from the booking URL
- `value_bucket` — `"free" | "paid"` (never the exact price)

**Forbidden:** email, name, phone, IP, booking ID, customer ID,
tenant UUID, exact price. The type system rejects these at compile
time.

## Server-to-client event dispatch

OAuth callbacks and Stripe redirects are server-side flows — they
can't call `gtag` directly. They append `?ga_event=<name>` (plus
optional `ga_<param>=<value>` keys) to the redirect URL. The client
side `GATracker` reads the param once, fires the typed event, then
calls `router.replace(...)` with the param stripped so it doesn't
re-fire on back/forward navigation.

Only event names in `ALL_GA4_EVENT_NAMES` are accepted from the URL
— anything else is ignored. This prevents a malicious or stale
query string from injecting arbitrary GA4 hits.

## Privacy posture

Set in the **initial config call** on `<Script id="ga4-init">` —
before any event can fire:

```js
gtag('set', {
  anonymize_ip: true,
  allow_google_signals: false,
  allow_ad_personalization_signals: false,
});
gtag('config', '<id>', {
  anonymize_ip: true,
  allow_google_signals: false,
  allow_ad_personalization_signals: false,
  send_page_view: false,        // we send page_view manually for SPA
  transport_type: 'beacon',     // survives page unload during nav
});
```

This is GDPR-safe by default: no advertising signals, no
cross-property linking, IP anonymized server-side by Google. No
consent banner is required for this configuration in EU
jurisdictions, though one is recommended if you later flip Google
Signals on.

## Realtime verification

After deploy:

1. Open `https://analytics.google.com/` → property
   `G-ZD40BSLJRY` → **Reports → Realtime**.
2. In another tab, open `https://zentromeet.com` (public site).
   Within ~30 s you should see **1 user in the last 30 minutes**.
3. Navigate to `/pricing`. The realtime view should show a
   `page_view` for `/pricing`.
4. Open `https://app.zentromeet.com/dashboard/login`, click
   "Create one" to switch to signup mode. The realtime view should
   show a `signup_started` event.
5. Complete a test booking via a `/u/<slug>/<service-slug>` page:
   - For a **free** service, the confirmation step fires
     `booking_completed` with `value_bucket=free`.
   - For a **paid** service, Stripe redirects to `/booking/confirmed
     ?booking=<id>`, the page fires `booking_completed` with
     `value_bucket=paid`.
6. Subscribe to a paid plan via `/dashboard/billing`. You should
   see two events in close succession: `stripe_checkout_started`
   (just before redirect), then `subscription_started` (when Stripe
   redirects back).
7. Connect Google Calendar via `/dashboard/settings/calendar`. The
   callback redirect appends `?ga_event=google_connected`, the
   `GATracker` fires it, then strips the param. Verify the event
   appears in realtime AND the URL ends up clean
   (`/dashboard/settings/calendar?connected=google`).

## Operating notes

- **Bundle size:** the GA helpers are tree-shakeable; only what's
  imported ships to the client. `GAProvider` itself is < 2 kB
  gzipped (the `gtag.js` external script is ~28 kB and cached
  cross-site by every Google property).
- **No build break when env is unset:** local dev and PR previews
  without the env var skip the entire injection path. CI never
  needs to set the env var.
- **Disabling temporarily:** unset `NEXT_PUBLIC_GA_MEASUREMENT_ID`
  in `.env` and rebuild. No code changes required.
- **Adding a new event:**
  1. Add the name to `GA4EventName` (`lib/analytics/ga4/types.ts`).
  2. Add it to `ALL_GA4_EVENT_NAMES` (`lib/analytics/ga4/client.ts`).
  3. Add a row to the event catalogue above.
  4. Add a `trackEvent("<name>", ...)` call at the appropriate
     site. For server-side flows, append
     `?ga_event=<name>&ga_<param>=<value>` to the redirect URL.
  5. Update `tests/ga4-client.test.ts` if the parameter contract
     changes.

## Why no `<script>` is mounted when env is missing

`getMeasurementId()` returns null when:
- env var is undefined
- env var is the empty string
- env var doesn't match `/^G-[A-Z0-9]{6,}$/`

`GAProvider` short-circuits on `if (!measurementId) return null;`
— no `<Script>` mounts, no `<Suspense>` boundary, no `GATracker`.
The rest of the app is byte-identical to a build without GA4.

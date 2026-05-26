/**
 * Phase GA4 — client-side telemetry helpers.
 *
 * Pure typed wrappers around window.gtag. SSR-safe:
 *   • Every function returns a no-op during SSR (typeof window
 *     !== "undefined" guard) so importing from a server component
 *     is harmless.
 *   • All paths short-circuit cleanly when the Measurement ID env
 *     var is missing (e.g. dev environments without GA configured).
 *
 * Privacy posture:
 *   • The <Script> tag mounted by GAProvider sets `anonymize_ip`,
 *     `allow_google_signals: false`, and `allow_ad_personalization
 *     _signals: false` on the initial config call.
 *   • This module NEVER sends customer / booking / payment identifiers.
 *     The GA4EventParams type at lib/analytics/ga4/types.ts is the
 *     enforced contract.
 *
 * No business data ever crosses into Google Analytics — this is
 * categorical-only product telemetry.
 */

import type {
  GA4EventName,
  GA4EventParams,
  GtagFn,
} from "./types";

/** Read the public measurement ID. Returns null when unset (e.g.
 *  local dev). Components SHOULD bail early when this is null. */
export function getMeasurementId(): string | null {
  // NEXT_PUBLIC_* env vars are inlined into the client bundle at
  // build time. We must NOT read from a non-NEXT_PUBLIC name here
  // — that would resolve to undefined on the client.
  const id = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  if (typeof id !== "string" || id.length === 0) return null;
  // Basic format guard. GA4 IDs are "G-XXXXXXXXXX" (10 chars after
  // G-). Wrong-format values short-circuit so a typo in .env doesn't
  // silently send hits to a wrong property.
  if (!/^G-[A-Z0-9]{6,}$/.test(id)) return null;
  return id;
}

/** True when GA4 should be ACTIVE. We require:
 *    1. We're in the browser.
 *    2. The Measurement ID env var is set and well-formed.
 *  We do NOT gate on NODE_ENV — operators sometimes want a
 *  staging environment with its own Measurement ID. Operators
 *  who want production-only behavior should simply omit the env
 *  var elsewhere. */
export function isGAEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return getMeasurementId() !== null;
}

/** Internal — resolve gtag, or return a no-op stub so callers
 *  don't have to null-check. */
function gtag(): GtagFn {
  if (typeof window === "undefined") {
    return ((..._args: unknown[]) => undefined) as unknown as GtagFn;
  }
  const w = window as unknown as { gtag?: GtagFn };
  return w.gtag ?? (((..._args: unknown[]) => undefined) as unknown as GtagFn);
}

/**
 * Initialize the dataLayer + gtag stub BEFORE the GA script loads.
 * Called once by GAProvider on first mount. Idempotent — calling
 * twice is a no-op because we guard on the global.
 */
export function initializeGA(): void {
  if (typeof window === "undefined") return;
  const id = getMeasurementId();
  if (!id) return;

  const w = window as unknown as {
    dataLayer?: unknown[];
    gtag?: GtagFn;
  };

  // gtag stub queues calls onto dataLayer until the loaded script
  // takes over. Standard Google pattern.
  if (!w.dataLayer) w.dataLayer = [];
  if (!w.gtag) {
    // eslint-disable-next-line prefer-rest-params
    w.gtag = function gtag(..._args: unknown[]) {
      (w.dataLayer as unknown[]).push(arguments);
    } as unknown as GtagFn;
  }
}

/**
 * Track a SPA route change. Called by GAProvider whenever the App
 * Router pathname or search params change. We send `page_view`
 * directly rather than relying on the auto-instrumentation
 * `send_page_view: true` on config because Next.js client-side
 * navigation doesn't fire a fresh page load.
 */
export function trackPageView(path: string, search?: string): void {
  if (!isGAEnabled()) return;
  const id = getMeasurementId();
  if (!id) return;
  const fullPath = search ? `${path}${search.startsWith("?") ? search : `?${search}`}` : path;
  gtag()("event", "page_view", {
    page_path: fullPath,
    page_location:
      typeof window !== "undefined" && window.location
        ? `${window.location.origin}${fullPath}`
        : undefined,
    send_to: id,
  });
}

/**
 * Track a typed custom event. The event name is constrained to the
 * GA4EventName union so a typo at the call site is caught at build
 * time. Params are constrained to GA4EventParams.
 */
export function trackEvent(name: GA4EventName, params?: GA4EventParams): void {
  if (!isGAEnabled()) return;
  // We deliberately spread params through Object.assign rather than
  // forwarding the literal object so we can strip undefined values
  // — GA4 treats `param: undefined` as a no-op anyway, but stripped
  // payloads are smaller and easier to debug in the Realtime view.
  const cleanParams: Record<string, unknown> = {};
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") cleanParams[k] = v;
    }
  }
  gtag()("event", name, cleanParams);
}

/** The complete list of event names — exported for tests + docs. */
export const ALL_GA4_EVENT_NAMES: ReadonlyArray<GA4EventName> = [
  "signup_started",
  "signup_completed",
  "demo_requested",
  "booking_completed",
  "stripe_checkout_started",
  "subscription_started",
  "calendar_connected",
  "google_connected",
  "microsoft_connected",
] as const;

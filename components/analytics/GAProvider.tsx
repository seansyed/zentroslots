"use client";

/**
 * Phase GA4 — Google Analytics 4 provider.
 *
 * Mounted ONCE in app/layout.tsx so it covers both surfaces served
 * by this Next.js app:
 *   • Public marketing routes (/, /pricing, /features, /for/[vertical])
 *   • Authenticated app routes (/dashboard/**, /u/[slug]/**)
 *
 * Responsibilities:
 *   1. Inject the gtag.js script (only when NEXT_PUBLIC_GA_MEASUREMENT_ID
 *      is set + well-formed — see lib/analytics/ga4/client.ts).
 *   2. Initial config with privacy-safe defaults (anonymize IP,
 *      Google signals OFF, ad personalization OFF).
 *   3. Track SPA route changes on every (pathname, searchParams) tick.
 *   4. Read `?ga_event=<name>` from the URL — fires the named event
 *      then strips the param so it doesn't re-fire on subsequent
 *      navigations. This is how server-side flows (OAuth callbacks,
 *      Stripe checkout success URL) report success to GA.
 *
 * SSR-safe: this component uses "use client" and wraps the
 * useSearchParams call in Suspense per Next.js 15 requirements.
 *
 * Graceful no-op when NEXT_PUBLIC_GA_MEASUREMENT_ID is unset — no
 * <Script> mounted, no events fired, zero network calls.
 */

import * as React from "react";
import Script from "next/script";
import { usePathname, useSearchParams, useRouter } from "next/navigation";

import {
  getMeasurementId,
  initializeGA,
  isGAEnabled,
  trackEvent,
  trackPageView,
  ALL_GA4_EVENT_NAMES,
} from "@/lib/analytics/ga4/client";
import type { GA4EventName } from "@/lib/analytics/ga4/types";

/** URL-param dispatcher: server redirects with `?ga_event=foo` and
 *  this set governs which names are accepted client-side. Anything
 *  else is ignored so a stray query param can't push a wrong event. */
const ALLOWED_URL_EVENTS = new Set<string>(ALL_GA4_EVENT_NAMES);

/**
 * Inner tracker — uses useSearchParams() which Next.js 15 requires
 * be inside a Suspense boundary. The outer GAProvider wraps it.
 */
function GATracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  // ─── Page view tracking on every route change ────────────────────
  // App Router's pathname + searchParams are independent change
  // signals; we depend on both so a query-string-only change (e.g.
  // ?tab=upcoming) still records a fresh hit. The first render
  // also fires here because the effect runs on mount.
  React.useEffect(() => {
    if (!isGAEnabled()) return;
    const search = searchParams?.toString() ?? "";
    trackPageView(pathname ?? "/", search ? `?${search}` : "");
  }, [pathname, searchParams]);

  // ─── URL-param event dispatch ────────────────────────────────────
  // Server-side flows (OAuth callbacks, Stripe success URL) cannot
  // call gtag directly. They redirect the browser to a destination
  // URL with `?ga_event=<name>` appended. We read it once, fire
  // the event, then replace the URL without the param so it can't
  // re-fire on subsequent navigations (e.g. a user clicking the
  // back button after a successful OAuth flow).
  React.useEffect(() => {
    if (!isGAEnabled()) return;
    if (!searchParams) return;
    const eventParam = searchParams.get("ga_event");
    if (!eventParam || !ALLOWED_URL_EVENTS.has(eventParam)) return;

    // Collect optional event params from the URL — only the
    // whitelisted keys per GA4EventParams. Anything else is dropped.
    const params: Record<string, string> = {};
    for (const k of [
      "plan",
      "interval",
      "provider",
      "service_name",
      "tenant_slug",
      "value_bucket",
    ]) {
      const v = searchParams.get(`ga_${k}`);
      if (v) params[k] = v;
    }

    trackEvent(eventParam as GA4EventName, params);

    // Strip ga_* params from the URL so they don't re-fire and
    // don't clutter what the user sees. Replace, not push, so
    // browser history stays clean.
    const next = new URLSearchParams(searchParams.toString());
    const keysToStrip: string[] = [];
    next.forEach((_, key) => {
      if (key === "ga_event" || key.startsWith("ga_")) keysToStrip.push(key);
    });
    for (const k of keysToStrip) next.delete(k);
    const nextQs = next.toString();
    const nextUrl = `${pathname ?? "/"}${nextQs ? `?${nextQs}` : ""}`;
    router.replace(nextUrl, { scroll: false });
  }, [pathname, searchParams, router]);

  return null;
}

export default function GAProvider() {
  const measurementId = getMeasurementId();

  // No measurement ID → render nothing. The rest of the app behaves
  // identically to before this phase shipped.
  if (!measurementId) return null;

  return (
    <>
      {/* Pre-load gtag stub so calls fired BEFORE the external script
          finishes loading still queue correctly onto dataLayer. */}
      <Script
        id="ga4-init"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            window.gtag = gtag;
            gtag('js', new Date());
            gtag('set', {
              anonymize_ip: true,
              allow_google_signals: false,
              allow_ad_personalization_signals: false,
            });
            gtag('config', '${measurementId}', {
              anonymize_ip: true,
              allow_google_signals: false,
              allow_ad_personalization_signals: false,
              send_page_view: false,
              transport_type: 'beacon',
            });
          `,
        }}
        onLoad={() => initializeGA()}
      />
      <Script
        id="ga4-loader"
        strategy="afterInteractive"
        src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`}
      />
      {/* useSearchParams must live inside a Suspense boundary per
          Next.js 15 requirements. */}
      <React.Suspense fallback={null}>
        <GATracker />
      </React.Suspense>
    </>
  );
}

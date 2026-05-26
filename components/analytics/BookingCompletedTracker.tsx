"use client";

/**
 * Phase GA4 — fires the `booking_completed` GA4 event ONCE per
 * confirmation-page load.
 *
 * Rendered inside app/booking/confirmed/page.tsx (a server component),
 * which already gates on a valid signed booking lookup before mounting
 * us — so by the time we run we know:
 *   • the booking exists,
 *   • the customer reached the success page (either free booking
 *     finalized inline, or paid booking where the webhook will flip
 *     status to `confirmed` shortly).
 *
 * What we send:
 *   • event:        booking_completed
 *   • value_bucket: "free" | "paid"  (categorical — never the price)
 *   • service_name: the categorical service label (no PII)
 *   • tenant_slug:  passed through when available (already public —
 *                   it's in the booking URL — safe to attach)
 *
 * What we DO NOT send: booking ID, customer email/name/phone, exact
 * price, tenant UUID. The GA4EventParams type at lib/analytics/ga4/
 * types.ts is the enforced contract.
 *
 * De-dupe: we use a `sessionStorage` flag keyed by booking ID so that
 * a page refresh on the same tab doesn't double-count. Cross-tab is
 * acceptably rare and Google Analytics' own per-session de-dupe at
 * the property level absorbs it.
 */

import * as React from "react";

import { isGAEnabled, trackEvent } from "@/lib/analytics/ga4/client";

type Props = {
  /** UUID — used only as the de-dupe sessionStorage key. NOT sent to GA4. */
  bookingId: string;
  /** "free" | "paid" — coarse value bucket. Derived from `services.price`. */
  valueBucket: "free" | "paid";
  /** Service display name (no PII — categorical product label). */
  serviceName: string;
  /** Tenant slug (public — appears in the booking URL). Optional. */
  tenantSlug?: string | null;
};

export default function BookingCompletedTracker({
  bookingId,
  valueBucket,
  serviceName,
  tenantSlug,
}: Props) {
  React.useEffect(() => {
    if (!isGAEnabled()) return;
    // De-dupe per browser session — a refresh on the same booking
    // confirmation should NOT fire a second event.
    const key = `ga4:booking_completed:${bookingId}`;
    try {
      if (typeof window !== "undefined" && window.sessionStorage.getItem(key)) {
        return;
      }
      window.sessionStorage.setItem(key, "1");
    } catch {
      // Storage disabled (private mode, embedded webview, etc) — fall
      // through and fire the event anyway. Slight risk of double-fire
      // on refresh in those niche environments is acceptable.
    }

    trackEvent("booking_completed", {
      value_bucket: valueBucket,
      service_name: serviceName,
      ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    });
  }, [bookingId, valueBucket, serviceName, tenantSlug]);

  return null;
}

/**
 * Phase GA4 — typed contracts for Google Analytics 4 client.
 *
 * Sits ALONGSIDE the existing lib/analytics/* modules (revenue,
 * staffing, conversion, etc.) which compute server-side aggregates.
 * GA4 is the client-side telemetry channel; the two layers never
 * interact at runtime.
 *
 * No business data, no PII, no sensitive identifiers ever flow
 * through these types — only the page path + the small enum of
 * event names + optional plan/provider strings.
 */

/** The closed enum of custom events ZentroMeet emits. New events
 *  MUST be added here so trackEvent() stays type-safe and the
 *  documentation in docs/GA4.md stays current. */
export type GA4EventName =
  | "signup_started"
  | "signup_completed"
  | "demo_requested"
  | "booking_completed"
  | "stripe_checkout_started"
  | "subscription_started"
  | "calendar_connected"
  | "google_connected"
  | "microsoft_connected";

/** Allowed parameter shapes per event. Each entry is the set of
 *  fields that MAY be attached. All fields are optional — GA4 will
 *  still receive the event itself if params are omitted.
 *
 *  RULES enforced by these types:
 *    • No email / name / phone / IP / booking ID / customer ID.
 *    • Only categorical or coarse-numeric fields. */
export type GA4EventParams = {
  /** Service name (no PII). Used to bucket conversion analytics by
   *  service category. */
  service_name?: string;
  /** Plan slug — "free" | "solo" | "pro" | "team" | "enterprise". */
  plan?: string;
  /** Billing interval — "month" | "year". */
  interval?: "month" | "year";
  /** Calendar provider — "google" | "microsoft". */
  provider?: "google" | "microsoft";
  /** Tenant slug (already public — it's in the booking URL). NOT
   *  the tenant UUID. */
  tenant_slug?: string;
  /** Coarse value bucket for booking_completed — "free" | "paid" so
   *  GA4 can split conversion volume without exposing exact prices. */
  value_bucket?: "free" | "paid";
};

/** Shape of the window.gtag function injected by the GA4 script. */
export type GtagFn = {
  (command: "config", measurementId: string, config?: Record<string, unknown>): void;
  (command: "event", eventName: string, params?: Record<string, unknown>): void;
  (command: "set", params: Record<string, unknown>): void;
  (command: "js", date: Date): void;
};

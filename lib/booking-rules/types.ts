/**
 * Shared types for the booking-rules engine.
 *
 * `EffectiveRule` is what resolveBookingRules() returns: the merged
 * fields from the matching booking_rules row + the legacy
 * services.minNoticeMinutes / services.maxAdvanceDays as fallbacks.
 *
 * Validation error codes are a closed union — the public booking page
 * uses them to render friendly messages and our tests assert against
 * them. New codes require updating every consumer (deliberately).
 */

export type BusinessHourWindow = { start: string; end: string };
// Keyed by day of week (Sunday=0). Missing key = no booking that day.
export type BusinessHoursConfig = Record<string, BusinessHourWindow>;

export type EffectiveRule = {
  /** Source the resolver picked. Useful in the admin UI ("currently
   *  using tenant default" indicator) and in audit metadata. */
  source: "service" | "location" | "tenant" | "service_fields" | "none";
  /** Whether ANY rule was found at all. When false, the legacy
   *  services.minNoticeMinutes / maxAdvanceDays fields are the only
   *  things in effect (preserves byte-identical pre-feature behavior). */
  ruleFound: boolean;
  enabled: boolean;
  minNoticeMinutes: number | null;
  maxAdvanceDays: number | null;
  maxBookingsPerDay: number | null;
  maxBookingsPerCustomerPerDay: number | null;
  maxConcurrentBookings: number | null;
  cooldownMinutes: number | null;
  blackoutDates: string[];
  requireBusinessHours: boolean;
  businessHours: BusinessHoursConfig;
};

/**
 * Closed set of validation error codes. Consumers (HttpError messages,
 * public-page error rendering, audit logs) map codes to friendly text.
 */
export type RuleErrorCode =
  | "rule_disabled" // shouldn't reach the user; for completeness
  | "min_notice"
  | "max_advance"
  | "blackout_date"
  | "outside_business_hours"
  | "daily_cap"
  | "per_customer_daily_cap"
  | "concurrent_cap"
  | "cooldown";

export type RuleError = {
  code: RuleErrorCode;
  /** Customer-facing message. Never leaks rule config (e.g. exact
   *  cap counts). */
  message: string;
  /** Optional context for audit / debug. Not sent to the customer. */
  detail?: Record<string, unknown>;
};

export type ValidateInput = {
  tenantId: string;
  serviceId: string;
  locationId?: string | null;
  /** Customer email — used for per-customer + cooldown checks. */
  clientEmail: string;
  startAt: Date;
  endAt: Date;
};

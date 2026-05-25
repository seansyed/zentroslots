/**
 * Phase SMART-1 — typed contracts for the scheduling intelligence
 * overlay.
 *
 * This module sits ON TOP of the existing availability engine
 * (lib/availability.ts). It NEVER changes which slots are returned;
 * it only attaches scores + recommendation labels to them. The
 * booking engine's correctness guarantees (overlap-prevention,
 * working-hours respect, busy-source subtraction) are untouched.
 *
 * Determinism contract:
 *   • Every scoring function is a PURE FUNCTION over its inputs.
 *   • No Math.random(), no Date.now() side effects (callers pass `now`).
 *   • Same inputs → same outputs, always. This is critical so that
 *     the same booking page renders the same "Recommended" chips on
 *     consecutive loads, and so that tests assert against fixed values.
 *
 * No generative AI here. The intelligence is rule-based + weighted.
 */

/** A single available slot's start time, as an ISO 8601 UTC string.
 *  Matches what lib/availability.ts emits from getAvailableSlots(). */
export type SlotIso = string;

/** Factor name → weighted score [0..100] + diagnostic detail.
 *  Each factor is a separate signal so a downstream consumer (admin
 *  drilldown, A/B-tested weighting, debug log) can inspect each
 *  contribution independently. */
export type FactorScore = {
  /** Stable factor identifier. Used as a map key in breakdowns. */
  factor: ScoringFactor;
  /** 0..100 — 100 is most favorable. */
  score: number;
  /** Brief human explanation, e.g. "during lunch hour 12:00".
   *  Used in the admin diagnostics drawer + analytics export. */
  detail?: string;
};

/** Canonical list of scoring factors. New factors get appended;
 *  existing factor names are STABLE so external admin dashboards
 *  can rely on them. */
export type ScoringFactor =
  | "timeOfDay"           // morning vs late-afternoon preference
  | "lunchAvoidance"      // penalize lunch-hour slots
  | "endOfDayFatigue"     // penalize last working block of day
  | "bufferEfficiency"    // prefer slots that don't fragment the day
  | "backToBackPenalty"   // penalize when adjacent to many bookings
  | "focusBlockRespect"   // honor staff's protected quiet hours
  | "workloadBalance"     // round-robin fairness across staff
  | "timezoneFriendly"    // comfortable wall-clock for customer
  | "customerPreference"  // historical preferred-hour bias
  | "dailyDensity";       // penalize already-busy days

/** Composite score for one slot. */
export type SlotScore = {
  /** Weighted total in [0..100]. Higher = more recommended. */
  total: number;
  /** Per-factor contributions. Order is stable across calls so the
   *  same render is deterministic. */
  breakdown: FactorScore[];
};

/** Labels surfaced in the public booking UI. Multiple labels per
 *  slot are allowed (e.g. a slot can be both "Recommended" + "Best
 *  availability"). Labels are deterministic — for a given input
 *  set they're identical. */
export type SlotLabel =
  | "recommended"
  | "best_availability"
  | "least_busy_day"
  | "fastest_confirmation";

/** Slot annotated with its score + any UI labels. */
export type ScoredSlot = {
  /** Original slot start time (ISO UTC). The booking flow uses this
   *  verbatim when constructing the POST /api/bookings payload. */
  time: SlotIso;
  /** Composite score 0..100. */
  score: number;
  /** Optional UI labels. Empty array for unremarkable slots. */
  labels: SlotLabel[];
  /** Detailed breakdown — useful for admin diagnostics + debug logs.
   *  Public booking UI ignores this; only the score + labels render. */
  breakdown?: FactorScore[];
};

/** Per-tenant or per-staff intelligence configuration. Read from
 *  the jsonb `focus_rules` column on users / tenants. EVERY field
 *  is optional — the engine has a defaults baseline. */
export type FocusRules = {
  /** Hours the lunchAvoidance scorer treats as lunch (penalty
   *  applied). Default { start: 12, end: 13 } (local time at staff's
   *  timezone). */
  lunchHours?: { start: number; end: number };

  /** Minutes from the end of the working window that endOfDayFatigue
   *  applies. Default 30. */
  endOfDayDecayMin?: number;

  /** Max consecutive booked hours before backToBackPenalty triggers.
   *  Default 4. */
  maxConsecutiveHours?: number;

  /** Minimum buffer between bookings the bufferEfficiency scorer
   *  rewards. Default 10 minutes. */
  minBufferMinutes?: number;

  /** Daily soft cap on bookings per staff. workloadBalance scorer
   *  penalizes once this is reached. Default 8. */
  dailySoftCap?: number;

  /** Quiet hours (focus blocks) — slots inside these ranges get a
   *  heavy focusBlockRespect penalty. Empty by default. */
  quietHours?: { start: number; end: number }[];

  /** Customer-comfort wall-clock range. timezoneFriendly scorer
   *  rewards slots inside this. Default 9–18. */
  customerPreferredHours?: { start: number; end: number };
};

/** Input context to score a single slot. Pure data — no DB handles,
 *  no functions, no async. This separation is what makes scoring
 *  deterministic + unit-testable. */
export type SlotContext = {
  /** The slot we're scoring. */
  slotStart: Date;
  /** Service duration — used for buffer/density calculations. */
  durationMinutes: number;
  /** Staff timezone (IANA). All hour-of-day comparisons happen in
   *  this zone. */
  staffTimezone: string;
  /** Customer's timezone (IANA), if known. Falls back to staff zone. */
  customerTimezone?: string;
  /** Working window for the day, in UTC. From lib/availability's
   *  resolved-windows pipeline. */
  workingWindow: { start: Date; end: Date };
  /** Other bookings on the same staff/day, in UTC. Used for density +
   *  buffer + back-to-back factors. */
  otherBookings: { start: Date; end: Date }[];
  /** Daily booking count on this staff for the date. Used for the
   *  workloadBalance soft cap. */
  staffDailyCount: number;
  /** Resolved focus rules (tenant-defaulted, staff-overridden). */
  rules: FocusRules;
  /** Optional customer preference profile from past bookings. Empty
   *  when the customer has no history with this tenant. */
  customerProfile?: CustomerPreferenceProfile;
};

/** Aggregated customer pattern from prior bookings — derived
 *  per-tenant per-clientEmail. Never crosses tenant boundaries. */
export type CustomerPreferenceProfile = {
  /** Histogram of hour-of-day (0..23) → count from past bookings.
   *  customerPreference scorer weights by this. */
  preferredHourHistogram: number[];
  /** Histogram of day-of-week (0=Sun..6=Sat) → count. */
  preferredDayHistogram: number[];
  /** Total observation count — caller uses this to decide whether
   *  the histogram has enough signal to trust. <3 bookings = ignore. */
  sampleSize: number;
  /** Reschedule rate [0..1] — high = customer is flaky, soften
   *  any "Recommended" elevation a bit. */
  rescheduleRate: number;
  /** No-show rate [0..1] — high = same. */
  noShowRate: number;
};

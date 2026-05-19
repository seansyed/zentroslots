/**
 * Operational recommendations engine — deterministic.
 *
 * Every recommendation cites the EXACT metric that triggered it.
 * No generic AI filler. No emit when the data doesn't support the
 * claim.
 *
 * Pure — composes forecasting + staffing insights into actionable
 * strings. Doesn't query DB.
 */
import type { ForecastResult } from "./forecasting";
import type { StaffingSignals } from "./staffingInsights";
import type { DailyAggregate } from "./types";

export type Recommendation = {
  code: string;
  message: string;
  /** Cited metric so the dashboard can show "Why?" tooltips. */
  evidence: string;
};

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LONG = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

export function buildRecommendations(args: {
  snapshots: DailyAggregate[];
  forecast: ForecastResult | null;
  staffingSignals: StaffingSignals;
}): Recommendation[] {
  const out: Recommendation[] = [];

  // ── Add staff availability on busy weekdays ────────────────────
  if (args.forecast && args.forecast.expectedBusyWeekdays.length > 0 && args.forecast.staffingPressureLevel !== "low") {
    const days = args.forecast.expectedBusyWeekdays.join(", ");
    out.push({
      code: "add_staff_busy_weekdays",
      message: `Consider adding staff availability on ${days}.`,
      evidence: `Staffing pressure level is ${args.forecast.staffingPressureLevel}; these weekdays exceed the trailing-window mean by ≥ 30%.`,
    });
  }

  // ── Peak hours hint ────────────────────────────────────────────
  if (args.forecast && args.forecast.expectedPeakHours.length > 0) {
    const hours = args.forecast.expectedPeakHours.sort((a, b) => a - b);
    if (hours.length >= 2) {
      const min = hours[0];
      const max = hours[hours.length - 1];
      out.push({
        code: "peak_hours_window",
        message: `Bookings concentrate between ${formatHour(min)} and ${formatHour(max + 1)}. Schedule senior staff in this window.`,
        evidence: `Hours ${hours.map(formatHour).join(", ")} each exceed the trailing-window mean by ≥ 30%.`,
      });
    }
  }

  // ── Cancellation correlation with reminder suppression ─────────
  // If suppressions are non-trivial AND cancellations are elevated,
  // emit a cited recommendation. NOT a causal claim — a correlation
  // worth investigating.
  if (args.snapshots.length >= 7) {
    const totalSuppressed = args.snapshots.reduce((a, s) => a + s.reminderEmailsSuppressed, 0);
    const totalReminders = args.snapshots.reduce((a, s) => a + s.reminderEmailsSent + s.reminderEmailsSuppressed, 0);
    const suppressedRate = totalReminders > 0 ? totalSuppressed / totalReminders : 0;
    const totalBookings = args.snapshots.reduce((a, s) => a + s.totalBookings, 0);
    const totalCancels = args.snapshots.reduce((a, s) => a + s.cancelledBookings, 0);
    const cancelRate = totalBookings > 0 ? totalCancels / totalBookings : 0;
    if (suppressedRate > 0.2 && cancelRate > 0.15) {
      out.push({
        code: "reminder_suppression_correlation",
        message: "Reminder suppressions and cancellations are both elevated — review opt-out messaging.",
        evidence: `Suppression rate ${Math.round(suppressedRate * 100)}%, cancellation rate ${Math.round(cancelRate * 100)}% across ${args.snapshots.length} days.`,
      });
    }
  }

  // ── Underutilized staff ─────────────────────────────────────────
  if (args.staffingSignals.underutilizedStaff > 0 && args.forecast?.staffingPressureLevel === "low") {
    out.push({
      code: "underutilized_staff_with_low_pressure",
      message: `${args.staffingSignals.underutilizedStaff} staff member${
        args.staffingSignals.underutilizedStaff === 1 ? " is" : "s are"
      } significantly underbooked while overall demand is low — consider scheduling adjustments.`,
      evidence: `${args.staffingSignals.underutilizedStaff} staff under 10% of team average; staffing pressure low.`,
    });
  }

  // ── Overloaded staff routing tweak ─────────────────────────────
  if (args.staffingSignals.overloadStaff > 0) {
    out.push({
      code: "rebalance_routing",
      message: "Switch routing mode to least-busy or weighted to spread load away from overloaded staff.",
      evidence: `${args.staffingSignals.overloadStaff} staff handle ≥ 50% of bookings.`,
    });
  }

  // ── High cancellation weekdays ──────────────────────────────────
  if (args.staffingSignals.highCancelWeekdays.length > 0) {
    const names = args.staffingSignals.highCancelWeekdays.map((i) => WEEKDAY_LONG[i]).join(", ");
    out.push({
      code: "investigate_high_cancel_weekdays",
      message: `Cancellation rates spike on ${names}. Check if staffing or scheduling needs tweaking on those days.`,
      evidence: `Per-weekday cancellation rate > 50% above tenant baseline.`,
    });
  }

  // ── Booking surge — staffing alert ──────────────────────────────
  if (args.staffingSignals.bookingSurge) {
    out.push({
      code: "booking_surge_alert",
      message: "Bookings are surging — confirm staff availability windows can absorb the upcoming load.",
      evidence: "Recent half of the window exceeds the prior half by ≥ 30%.",
    });
  }

  return out;
}

function formatHour(hour: number): string {
  // 0..23 → "12AM..11PM"
  const h = ((hour + 11) % 12) + 1;
  const suffix = hour < 12 ? "AM" : "PM";
  return `${h}${suffix}`;
}

void WEEKDAY_NAMES; // reserved for future short-form recommendation phrasing

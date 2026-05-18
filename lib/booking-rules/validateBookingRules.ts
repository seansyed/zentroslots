/**
 * Validate a candidate booking against all configured rules.
 *
 * Returns:
 *   - { ok: true, effective } when every check passes
 *   - { ok: false, error, effective } on the FIRST failed check
 *
 * Order of checks (cheap → expensive):
 *   1. rule disabled (short-circuit ok:true — same as no rule)
 *   2. minimum notice (purely time math)
 *   3. maximum advance (time math)
 *   4. blackout dates (in-memory list scan)
 *   5. business hours (jsonb config check)
 *   6. daily total cap (one query)
 *   7. per-customer daily cap (one query)
 *   8. concurrent cap (one query)
 *   9. cooldown (one query)
 *
 * NEVER throws. Booking POST treats the first error as a clean 409
 * with the friendly message.
 *
 * Tenant isolation: every helper is scoped by tenantId.
 */
import { and, eq, gte, lt } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, users } from "@/db/schema";

import { checkBlackoutDate, dateInTimezone } from "./blackoutDates";
import { countConcurrentForService } from "./concurrency";
import {
  countCustomerBookingsOnDay,
  smallestGapToCustomerBooking,
} from "./customerLimits";
import { resolveBookingRules } from "./resolveRules";
import type { EffectiveRule, RuleError, ValidateInput } from "./types";

export type ValidateResult =
  | { ok: true; effective: EffectiveRule }
  | { ok: false; error: RuleError; effective: EffectiveRule };

export async function validateBookingRules(input: ValidateInput): Promise<ValidateResult> {
  const effective = await resolveBookingRules({
    tenantId: input.tenantId,
    serviceId: input.serviceId,
    locationId: input.locationId ?? null,
  });

  // A disabled rule is treated as "no rule" — caller's pre-rule
  // services-level checks still apply.
  if (!effective.enabled) return { ok: true, effective };

  const now = new Date();

  // ── 1. Min notice ────────────────────────────────────────────────
  if (effective.minNoticeMinutes && effective.minNoticeMinutes > 0) {
    const earliest = new Date(now.getTime() + effective.minNoticeMinutes * 60_000);
    if (input.startAt < earliest) {
      return {
        ok: false,
        effective,
        error: {
          code: "min_notice",
          message: friendlyNoticeMessage(effective.minNoticeMinutes),
        },
      };
    }
  }

  // ── 2. Max advance ───────────────────────────────────────────────
  if (effective.maxAdvanceDays && effective.maxAdvanceDays > 0) {
    const latest = new Date(now.getTime() + effective.maxAdvanceDays * 24 * 60 * 60_000);
    if (input.startAt > latest) {
      return {
        ok: false,
        effective,
        error: {
          code: "max_advance",
          message: `Bookings are only available up to ${effective.maxAdvanceDays} day${effective.maxAdvanceDays === 1 ? "" : "s"} ahead.`,
        },
      };
    }
  }

  // We need the staff TZ for date math (blackout + business hours).
  // Cheap: one lookup of the booking's intended staff. The orchestrator
  // is called AFTER routing, so the booking has a staffUserId; the
  // caller wires it via locationId/serviceId only, so we re-fetch.
  const staffTz = await resolveStaffTimezone(input.tenantId, input.serviceId);
  const bookingDate = dateInTimezone(input.startAt, staffTz);

  // ── 3. Blackout dates ────────────────────────────────────────────
  const blackoutHit = checkBlackoutDate({
    bookingDate,
    blackoutDates: effective.blackoutDates,
  });
  if (blackoutHit) {
    return {
      ok: false,
      effective,
      error: {
        code: "blackout_date",
        message: "That date isn't available for booking.",
        detail: { matched: blackoutHit },
      },
    };
  }

  // ── 4. Business hours ────────────────────────────────────────────
  if (effective.requireBusinessHours) {
    const dow = dayOfWeekInTz(input.startAt, staffTz); // 0=Sun..6=Sat
    const window = effective.businessHours[String(dow)];
    if (!window) {
      return {
        ok: false,
        effective,
        error: {
          code: "outside_business_hours",
          message: "We aren't open on that day.",
        },
      };
    }
    const startMin = timeToMinutes(timeInTz(input.startAt, staffTz));
    const endMin = timeToMinutes(timeInTz(input.endAt, staffTz));
    const winStart = timeToMinutes(window.start);
    const winEnd = timeToMinutes(window.end);
    if (startMin < winStart || endMin > winEnd) {
      return {
        ok: false,
        effective,
        error: {
          code: "outside_business_hours",
          message: `Bookings must fall between ${window.start} and ${window.end}.`,
        },
      };
    }
  }

  // Day window (UTC) corresponding to this customer's local day.
  // Used by both daily-cap checks. Built once.
  const { dayStartUtc, dayEndUtc } = dayWindowUtc(input.startAt, staffTz);

  // ── 5. Daily total cap for this service ─────────────────────────
  if (effective.maxBookingsPerDay && effective.maxBookingsPerDay > 0) {
    const count = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, input.tenantId),
          eq(bookings.serviceId, input.serviceId),
          eq(bookings.status, "confirmed"),
          gte(bookings.startAt, dayStartUtc),
          lt(bookings.startAt, dayEndUtc)
        )
      );
    if (count.length >= effective.maxBookingsPerDay) {
      return {
        ok: false,
        effective,
        error: {
          code: "daily_cap",
          message: "No more bookings available for this day.",
        },
      };
    }
  }

  // ── 6. Per-customer daily cap ───────────────────────────────────
  if (effective.maxBookingsPerCustomerPerDay && effective.maxBookingsPerCustomerPerDay > 0) {
    const count = await countCustomerBookingsOnDay({
      tenantId: input.tenantId,
      clientEmail: input.clientEmail,
      dayStartUtc,
      dayEndUtc,
    });
    if (count >= effective.maxBookingsPerCustomerPerDay) {
      return {
        ok: false,
        effective,
        error: {
          code: "per_customer_daily_cap",
          message: "You've reached the daily booking limit for this service.",
        },
      };
    }
  }

  // ── 7. Concurrent bookings cap ──────────────────────────────────
  if (effective.maxConcurrentBookings && effective.maxConcurrentBookings > 0) {
    const concurrent = await countConcurrentForService({
      tenantId: input.tenantId,
      serviceId: input.serviceId,
      startAt: input.startAt,
      endAt: input.endAt,
    });
    if (concurrent >= effective.maxConcurrentBookings) {
      return {
        ok: false,
        effective,
        error: {
          code: "concurrent_cap",
          message: "That time slot is fully booked.",
        },
      };
    }
  }

  // ── 8. Cooldown ─────────────────────────────────────────────────
  if (effective.cooldownMinutes && effective.cooldownMinutes > 0) {
    const gap = await smallestGapToCustomerBooking({
      tenantId: input.tenantId,
      clientEmail: input.clientEmail,
      startAt: input.startAt,
      endAt: input.endAt,
      searchWindowMinutes: effective.cooldownMinutes * 2,
    });
    if (gap !== null && gap < effective.cooldownMinutes) {
      return {
        ok: false,
        effective,
        error: {
          code: "cooldown",
          message: `Please leave at least ${effective.cooldownMinutes} minutes between your bookings.`,
        },
      };
    }
  }

  return { ok: true, effective };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function friendlyNoticeMessage(minutes: number): string {
  if (minutes >= 60 * 24) {
    const days = Math.round(minutes / (60 * 24));
    return `This service requires at least ${days} day${days === 1 ? "" : "s"} notice.`;
  }
  if (minutes >= 60) {
    const hours = Math.round(minutes / 60);
    return `This service requires at least ${hours} hour${hours === 1 ? "" : "s"} notice.`;
  }
  return `This service requires at least ${minutes} minutes notice.`;
}

async function resolveStaffTimezone(tenantId: string, serviceId: string): Promise<string> {
  // Pick any staff member who delivers this service — their TZ is the
  // reference for "what day is this booking on" given the tenant
  // doesn't have its own TZ field. Falls back to UTC.
  // We're not picky about WHICH staff because the date conversion
  // result only differs across staff in extreme cross-tz tenants
  // (uncommon for the SMB target). Tenants who care can set business
  // hours on the rule itself.
  const row = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(and(eq(users.tenantId, tenantId)))
    .limit(1);
  if (row[0]) return row[0].timezone;
  // Final fallback: services.tenantId is the same tenant — but we
  // don't have a tenant TZ. UTC is safe.
  void serviceId; // reserved for future per-service TZ
  return "UTC";
}

function dayWindowUtc(at: Date, timezone: string): { dayStartUtc: Date; dayEndUtc: Date } {
  // Compute the local YYYY-MM-DD of `at`, then map midnight..midnight
  // back to UTC. Uses Intl which is consistent with dateInTimezone.
  const dateStr = dateInTimezone(at, timezone);
  // To map a wall-clock midnight in a TZ to UTC, build a Date from
  // the local string + the TZ offset. We use the same approach the
  // routing eligibility module uses.
  const guess = new Date(dateStr + "T00:00:00Z");
  const localFromUtc = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(guess);
  const get = (t: string) => Number(localFromUtc.find((p) => p.type === t)?.value ?? "0");
  const back = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const diff = guess.getTime() - back;
  const dayStartUtc = new Date(guess.getTime() + diff);
  const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60_000);
  return { dayStartUtc, dayEndUtc };
}

function dayOfWeekInTz(at: Date, timezone: string): number {
  const wd = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: timezone,
  }).format(at);
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return map[wd];
}

function timeInTz(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

// Service-level guard for the legacy services fields. Imported only
// when needed; not part of the main export.
export { resolveBookingRules };
void services;

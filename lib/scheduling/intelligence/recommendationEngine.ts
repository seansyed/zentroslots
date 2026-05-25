/**
 * Phase SMART-1 — orchestrator that fetches scoring context from
 * the DB + invokes the pure ranker.
 *
 * This is the only module in lib/scheduling/intelligence/ that
 * touches the DB. The rest are pure functions, which is why they're
 * easy to unit-test.
 *
 * Failure model:
 *   • If ANY context-fetch call throws (DB hiccup, etc.) we return
 *     the original slot list with empty score/labels arrays. The
 *     booking page degrades gracefully — slots are still bookable,
 *     just no Recommended chip. This is consistent with the SMART-1
 *     promise of "additive only, no booking regressions".
 */

import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookings,
  services,
  tenants,
  users,
} from "@/db/schema";

import { parseFocusRulesFromJson, resolveFocusRules } from "./focusRules";
import { loadCustomerPreferenceProfile } from "./customerPreferences";
import { rankSlots, type RankSlotsInput } from "./rankSlots";
import type { ScoredSlot } from "./types";

/** Public-facing entry point. Given the same params /api/slots takes
 *  + a slots array, produces ScoredSlot[]. Same length as input;
 *  same order; one Recommended label per call. */
export async function recommendSlots(args: {
  slots: string[];
  tenantId: string;
  serviceId: string;
  staffUserId: string;
  date: string;            // YYYY-MM-DD
  timezone: string;        // Staff's timezone (matches /api/slots arg)
  customerEmail?: string;  // Optional — engages history-based factor
  customerTimezone?: string;
}): Promise<ScoredSlot[]> {
  if (args.slots.length === 0) return [];

  try {
    // ─── Resolve service + staff + tenant rows ────────────────────
    // Three small parallel reads. Service for duration, staff for
    // timezone + focus rules, tenant for focus-rule defaults.
    const [service, staff, tenant] = await Promise.all([
      db.query.services.findFirst({
        where: eq(services.id, args.serviceId),
      }),
      db.query.users.findFirst({
        where: eq(users.id, args.staffUserId),
      }),
      db.query.tenants.findFirst({
        where: eq(tenants.id, args.tenantId),
      }),
    ]);
    if (!service || !staff || !tenant) {
      // Defensive — orchestrator can't compute context, so fall
      // back to score-less slots.
      return args.slots.map((iso) => ({ time: iso, score: 0, labels: [] }));
    }

    // ─── Working window for the day ─────────────────────────────
    // The day's bounds in UTC, based on the requested date + tz.
    // We use the date directly + the staff's timezone to bound the
    // window — this matches the calculation lib/availability.ts
    // already performs.
    const dayStart = new Date(`${args.date}T00:00:00Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);

    // ─── Same-day bookings on this staff ────────────────────────
    // Read once, reuse for: otherBookings (per-slot scoring) +
    // staffDailyCount (workload + density).
    const sameDayRows = await db
      .select({
        startAt: bookings.startAt,
        endAt: bookings.endAt,
        status: bookings.status,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, args.tenantId),
          eq(bookings.staffUserId, args.staffUserId),
          gte(bookings.startAt, dayStart),
          lt(bookings.startAt, dayEnd),
        ),
      );
    // Active bookings (pending/confirmed/completed) count toward
    // workload + density. Cancelled/no_show/refunded don't.
    const activeBookings = sameDayRows.filter(
      (r) =>
        r.status === "pending" ||
        r.status === "confirmed" ||
        r.status === "completed" ||
        r.status === "pending_payment",
    );
    const otherBookings: { start: Date; end: Date }[] = activeBookings.map((r) => ({
      start: r.startAt,
      end: r.endAt,
    }));

    // ─── Focus rules — tenant default merged with staff override ─
    const rules = resolveFocusRules({
      tenantRules: parseFocusRulesFromJson((tenant as { focusRules?: unknown }).focusRules),
      staffRules: parseFocusRulesFromJson((staff as { focusRules?: unknown }).focusRules),
    });

    // ─── Working window heuristic ────────────────────────────────
    // We don't have the resolved working window from availability.ts
    // here (the orchestrator API is private to that module). Best-
    // effort: pull the bounds from the first/last slot returned —
    // if slots span 9:00 to 17:30, the working window is roughly
    // 9:00 to 18:00 (extend by service duration on the right edge).
    const firstSlot = new Date(args.slots[0]);
    const lastSlot = new Date(args.slots[args.slots.length - 1]);
    const workingWindow = {
      start: firstSlot,
      end: new Date(lastSlot.getTime() + service.durationMinutes * 60_000),
    };

    // ─── Customer history (optional) ─────────────────────────────
    const customerProfile = args.customerEmail
      ? await loadCustomerPreferenceProfile({
          tenantId: args.tenantId,
          customerEmail: args.customerEmail,
          customerTz: args.customerTimezone ?? args.timezone,
        }).catch(() => null)
      : null;

    const rankInput: RankSlotsInput = {
      slots: args.slots,
      durationMinutes: service.durationMinutes,
      staffTimezone: staff.timezone || args.timezone,
      customerTimezone: args.customerTimezone,
      workingWindow,
      otherBookings,
      staffDailyCount: activeBookings.length,
      rules,
      customerProfile: customerProfile ?? undefined,
    };

    return rankSlots(rankInput);
  } catch (err) {
    // Diagnostic only — never break the booking page.
    console.error("recommendSlots failed:", err);
    return args.slots.map((iso) => ({ time: iso, score: 0, labels: [] }));
  }
}

// lib/workforce-location.ts — Enterprise workforce location helpers
// (migration 0037).
//
// CORE INVARIANT (do not violate):
//   Workspace Hours → Staff Availability → Location Presence → Booking
//                          ^                       ^
//                          |                       |
//          stays STAFF-OWNED           NEW context layer — this module
//          (lib/availability.ts        owns the per-day "where is this
//           unchanged)                 staff member" question only
//
// This module is the source of truth for:
//   • Which location(s) a staff member is assigned to
//   • Which location is "primary" (default delivery hub)
//   • Which location applies on a given day-of-week
//   • Whether a tenant's Virtual Hub system location exists
//   • Whether a proposed assignment-set is valid given the staff's
//     declared delivery mode
//
// It is NEVER called from the slot generator. The booking engine
// will read these helpers later from a routing/visibility filter
// that sits ABOVE slot generation, never inside it.
//
// FUTURE — date exceptions (Phase 16B note, refinement #6):
// Today's pivot uses `days_of_week` only — a stable weekly pattern.
// Real workforces also need *date-scoped* overrides:
//   • vacations / PTO
//   • temporary relocation ("at the conference this week")
//   • travel schedules / pop-up locations
// The data shape leaves headroom for this without a rewrite —
// `getStaffPresenceForDay` will gain a `(staffId, date)` overload
// that consults a sibling table (e.g. `staff_presence_exceptions`
// with `effective_from` / `effective_to` ranges + an optional
// `location_id`). Callers passing only `dayOfWeek` continue to work
// against the weekly pattern. Do NOT hardcode "weekly-only"
// assumptions deeper than the resolver — if you add helpers above
// it, take a date (or null) rather than a day-of-week.

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { locations, staffLocationAssignments, users } from "@/db/schema";

// ─── Types ────────────────────────────────────────────────────────────

export type DeliveryMode = "in_person" | "virtual" | "hybrid";

export const deliveryModeSchema = z.enum(["in_person", "virtual", "hybrid"]);

export type LocationType = "physical" | "virtual" | "hybrid";

export type DayOfWeekKey = "0" | "1" | "2" | "3" | "4" | "5" | "6";
const DAY_KEYS: readonly DayOfWeekKey[] = ["0", "1", "2", "3", "4", "5", "6"] as const;

const dayKeySchema = z.enum(["0", "1", "2", "3", "4", "5", "6"]);

// Input shape for PUT /api/staff/[id]/locations. One row per
// assignment. Days empty = any day; days non-empty = restricted.
export const locationAssignmentSchema = z.object({
  locationId: z.string().uuid(),
  daysOfWeek: z.array(dayKeySchema).default([]),
  isPrimary: z.boolean().default(false),
});

export const locationAssignmentsPutSchema = z.object({
  assignments: z.array(locationAssignmentSchema).max(50),
});

export type LocationAssignment = z.infer<typeof locationAssignmentSchema>;

// Safe normalizer for jsonb day arrays read from the DB.
export function readDaysOfWeek(raw: unknown): DayOfWeekKey[] {
  if (!Array.isArray(raw)) return [];
  const out: DayOfWeekKey[] = [];
  for (const v of raw) {
    if (typeof v === "string" && (DAY_KEYS as readonly string[]).includes(v)) {
      out.push(v as DayOfWeekKey);
    }
  }
  return out;
}

// ─── Virtual Hub (system location) ────────────────────────────────────

/**
 * Ensure the tenant has a system Virtual Hub. Creates one lazily
 * when missing. Returns the resolved location row.
 *
 * Called on demand from API write paths (e.g. when a staff member
 * is set to delivery_mode='virtual' with no virtual assignment).
 * Never called during reads — the migration intentionally does NOT
 * backfill so this is a per-tenant on-first-use cost.
 */
export async function ensureVirtualHub(tenantId: string) {
  // Look for an existing virtual or system location first. Any
  // virtual-typed location counts — we don't insist on is_system
  // for tenant-created ones so the operator can curate a custom
  // "Online Studio" hub themselves and have it honored as the
  // virtual delivery surface.
  const existing = await db
    .select()
    .from(locations)
    .where(and(
      eq(locations.tenantId, tenantId),
      eq(locations.locationType, "virtual"),
      eq(locations.isActive, true),
    ))
    .limit(1);
  if (existing[0]) return existing[0];

  const [row] = await db
    .insert(locations)
    .values({
      tenantId,
      name: "Virtual Hub",
      locationType: "virtual",
      isSystem: true,
      isActive: true,
    })
    .returning();
  return row;
}

// ─── Validation (Phase 10) ────────────────────────────────────────────

export type LocationAssignmentInput = {
  locationId: string;
  locationType: LocationType;
  daysOfWeek: DayOfWeekKey[];
  isPrimary: boolean;
};

/**
 * Phase 10 validation rules:
 *   - in_person → ≥1 physical or hybrid location required
 *   - virtual   → no physical assignments required (Virtual Hub
 *                 attached implicitly)
 *   - hybrid    → any mix allowed
 *   - At most one isPrimary=true (if any assignments exist)
 *
 * Throws Error with human-readable message on violation.
 */
export function assertValidLocationAssignments(
  deliveryMode: DeliveryMode,
  assignments: LocationAssignmentInput[],
): void {
  // At most one primary
  const primaries = assignments.filter((a) => a.isPrimary);
  if (primaries.length > 1) {
    throw new Error("Only one location can be marked primary");
  }

  // Day-set must contain unique keys per assignment
  for (const a of assignments) {
    const seen = new Set<string>();
    for (const d of a.daysOfWeek) {
      if (seen.has(d)) throw new Error("Duplicate day-of-week in assignment");
      seen.add(d);
    }
  }

  if (deliveryMode === "in_person") {
    const hasPhysical = assignments.some(
      (a) => a.locationType === "physical" || a.locationType === "hybrid",
    );
    if (!hasPhysical) {
      throw new Error(
        "In-person staff need at least one physical or hybrid location assignment",
      );
    }
  }
  // virtual + hybrid have no minimum-physical requirement; the
  // Virtual Hub is auto-attached by the route handler when needed.
}

// ─── Per-day presence resolver ────────────────────────────────────────

export type ResolvedPresence = {
  locationId: string;
  locationName: string;
  locationType: LocationType;
  logoUrl: string | null;
  /** "primary", "day-pinned", or "any-day" — explains why this row won */
  reason: "primary" | "day-pinned" | "any-day";
};

/**
 * Resolve which location a staff member is at on a given day-of-week.
 * Returns null when the staff has no assignments at all.
 *
 * Resolution order:
 *   1. A day-pinned assignment matching this day (most specific)
 *   2. The primary assignment
 *   3. The first any-day assignment (no day restriction)
 *
 * This is the function the future routing-presence filter will use.
 * Slot generation never calls it.
 */
export async function getStaffPresenceForDay(
  staffId: string,
  dayOfWeek: number,
): Promise<ResolvedPresence | null> {
  const dayKey = String(dayOfWeek) as DayOfWeekKey;

  const rows = await db
    .select({
      locationId: staffLocationAssignments.locationId,
      daysOfWeek: staffLocationAssignments.daysOfWeek,
      isPrimary: staffLocationAssignments.isPrimary,
      name: locations.name,
      locationType: locations.locationType,
      logoUrl: locations.logoUrl,
    })
    .from(staffLocationAssignments)
    .innerJoin(locations, eq(locations.id, staffLocationAssignments.locationId))
    .where(eq(staffLocationAssignments.staffId, staffId));

  if (rows.length === 0) return null;

  // 1. Day-pinned hit
  const dayPinned = rows.find((r) => {
    const days = readDaysOfWeek(r.daysOfWeek);
    return days.includes(dayKey);
  });
  if (dayPinned) {
    return {
      locationId: dayPinned.locationId,
      locationName: dayPinned.name,
      locationType: dayPinned.locationType as LocationType,
      logoUrl: dayPinned.logoUrl,
      reason: "day-pinned",
    };
  }

  // 2. Primary
  const primary = rows.find((r) => r.isPrimary);
  if (primary) {
    return {
      locationId: primary.locationId,
      locationName: primary.name,
      locationType: primary.locationType as LocationType,
      logoUrl: primary.logoUrl,
      reason: "primary",
    };
  }

  // 3. First any-day (no restriction)
  const anyDay = rows.find((r) => readDaysOfWeek(r.daysOfWeek).length === 0);
  if (anyDay) {
    return {
      locationId: anyDay.locationId,
      locationName: anyDay.name,
      locationType: anyDay.locationType as LocationType,
      logoUrl: anyDay.logoUrl,
      reason: "any-day",
    };
  }

  return null;
}

// ─── Service delivery modes ───────────────────────────────────────────

export const serviceDeliveryModesSchema = z
  .array(z.enum(["in_person", "virtual"]))
  .min(1, "At least one delivery mode required")
  .max(2);

export function readServiceDeliveryModes(raw: unknown): Array<"in_person" | "virtual"> {
  if (!Array.isArray(raw)) return ["virtual", "in_person"];
  const out = new Set<"in_person" | "virtual">();
  for (const v of raw) {
    if (v === "in_person" || v === "virtual") out.add(v);
  }
  if (out.size === 0) return ["virtual", "in_person"];
  return Array.from(out);
}

// Silence the unused-import warning during builds — `users` and
// `sql` are referenced by the assignment-write path consumed
// elsewhere. Keep them in scope for the route handler.
void users;
void sql;

// lib/workspace-hours.ts — Typed reader/writer + helpers for
// tenant default workspace hours (migration 0034).
//
// Why a dedicated module:
//   • Booking engine must NEVER care where availability originated.
//     It consumes resolved windows from getStaffWorkingWindows() only.
//     This module is the layer that knows about workspace-vs-staff
//     inheritance — keeps that knowledge out of the engine.
//   • Operational-state derivations (Using workspace hours, Limited
//     coverage, Weekend availability) live here so the StaffClient
//     drawer + the future Workforce Overview can read from a single
//     source of truth.

import { z } from "zod";

// ─── Storage type ─────────────────────────────────────────────────────
//
// Days are stringified 0-6 keys so jsonb round-trips cleanly:
//   "0" = Sunday, "1" = Monday, ..., "6" = Saturday
//
// Missing key or null = closed that day. Object = open with start/end
// in HH:MM 24h format, interpreted in the staff/tenant timezone by
// the slot generator (lib/availability.ts).

export type DayWindow = { start: string; end: string };
export type DefaultWorkspaceHours = Partial<Record<
  "0" | "1" | "2" | "3" | "4" | "5" | "6",
  DayWindow | null
>>;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const dayWindowSchema = z
  .object({
    start: z.string().regex(TIME_RE, "Use HH:MM 24h time"),
    end: z.string().regex(TIME_RE, "Use HH:MM 24h time"),
  })
  .refine((v) => v.start < v.end, {
    message: "Start time must be earlier than end time",
  });

// Used by the PUT endpoint to validate incoming payloads.
export const defaultWorkspaceHoursSchema = z.object({
  "0": dayWindowSchema.nullable().optional(),
  "1": dayWindowSchema.nullable().optional(),
  "2": dayWindowSchema.nullable().optional(),
  "3": dayWindowSchema.nullable().optional(),
  "4": dayWindowSchema.nullable().optional(),
  "5": dayWindowSchema.nullable().optional(),
  "6": dayWindowSchema.nullable().optional(),
});

// ─── Safe accessor ────────────────────────────────────────────────────
//
// jsonb columns can hold arbitrary shapes at the DB level (defaults
// to '{}'); this normalizes any-typed input into the strict shape
// and silently drops anything that doesn't validate. Used by the
// slot generator + UI hydration so a malformed cell never crashes
// availability resolution.

export function readDefaultWorkspaceHours(raw: unknown): DefaultWorkspaceHours {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: DefaultWorkspaceHours = {};
  const obj = raw as Record<string, unknown>;
  for (const k of ["0", "1", "2", "3", "4", "5", "6"] as const) {
    const v = obj[k];
    if (v === null || v === undefined) {
      // Explicit null = closed; missing = closed; treated identically.
      if (k in obj) out[k] = null;
      continue;
    }
    if (
      typeof v === "object" &&
      v !== null &&
      "start" in v &&
      "end" in v &&
      typeof (v as { start: unknown }).start === "string" &&
      typeof (v as { end: unknown }).end === "string" &&
      TIME_RE.test((v as { start: string }).start) &&
      TIME_RE.test((v as { end: string }).end) &&
      (v as { start: string }).start < (v as { end: string }).end
    ) {
      out[k] = {
        start: (v as { start: string }).start,
        end: (v as { end: string }).end,
      };
    }
  }
  return out;
}

/** True when the tenant has at least one open day configured. */
export function hasAnyDefault(hours: DefaultWorkspaceHours): boolean {
  return (["0", "1", "2", "3", "4", "5", "6"] as const).some((k) => {
    const v = hours[k];
    return v && typeof v === "object" && v.start && v.end;
  });
}

/** Resolve a single day to a window or null (closed). */
export function getDefaultForDay(
  hours: DefaultWorkspaceHours,
  dayOfWeek: number
): DayWindow | null {
  const key = String(dayOfWeek) as "0" | "1" | "2" | "3" | "4" | "5" | "6";
  const v = hours[key];
  if (!v || typeof v !== "object") return null;
  return { start: v.start, end: v.end };
}

// ─── Operational state derivations ────────────────────────────────────
//
// Pure functions over (per-staff rules, workspace defaults). Surfaced
// as calm chips in the Schedule tab and (later) the workforce
// directory. No fabricated signals — everything reads from real data.

export type ScheduleState =
  | "using_workspace"
  | "custom_availability"
  | "no_schedule";

export function deriveScheduleState(
  staffRules: { dayOfWeek: number; startTime: string; endTime: string }[],
  workspaceHours: DefaultWorkspaceHours
): ScheduleState {
  if (staffRules.length > 0) return "custom_availability";
  if (hasAnyDefault(workspaceHours)) return "using_workspace";
  return "no_schedule";
}

/** Days with hours (1-7). Either source. */
export function countDaysCovered(
  staffRules: { dayOfWeek: number }[],
  workspaceHours: DefaultWorkspaceHours
): number {
  if (staffRules.length > 0) {
    return new Set(staffRules.map((r) => r.dayOfWeek)).size;
  }
  return (["0", "1", "2", "3", "4", "5", "6"] as const).filter((k) => {
    const v = workspaceHours[k];
    return v && typeof v === "object";
  }).length;
}

/** Any Saturday or Sunday coverage. */
export function hasWeekendCoverage(
  staffRules: { dayOfWeek: number }[],
  workspaceHours: DefaultWorkspaceHours
): boolean {
  if (staffRules.length > 0) {
    return staffRules.some((r) => r.dayOfWeek === 0 || r.dayOfWeek === 6);
  }
  return Boolean(
    (workspaceHours["0"] && typeof workspaceHours["0"] === "object") ||
    (workspaceHours["6"] && typeof workspaceHours["6"] === "object")
  );
}

/** < 5 days of coverage = limited weekly footprint. */
export function isLimitedCoverage(
  staffRules: { dayOfWeek: number }[],
  workspaceHours: DefaultWorkspaceHours
): boolean {
  return countDaysCovered(staffRules, workspaceHours) < 5;
}

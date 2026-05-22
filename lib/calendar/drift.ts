/**
 * Wave E — sync drift detection.
 *
 * Detection-only in this wave: we record observed drift to
 * sync_drift_events but never auto-repair. A future wave will read
 * from this table to drive a reconciliation workflow + admin UI.
 *
 * Drift kinds:
 *   • event_missing      — booking has externalEventId but provider
 *                          returns 404 on lookup
 *   • meeting_link_lost  — booking has meetLink + isOnlineMeeting was
 *                          set, but provider event no longer reports
 *                          a join URL
 *   • time_mismatch      — provider event start/end differs from our
 *                          booking row by more than 5 minutes (most
 *                          likely staff manually moved it)
 *   • external_event     — webhook fired about an event we don't own
 *
 * The scan helpers are pure orchestration; they delegate provider
 * fetches to the existing adapters. Bounded per-pass batch size so a
 * single cron run can't monopolize the connection pool.
 */
import { and, desc, eq, gte, isNotNull } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, calendarConnections, syncDriftEvents } from "@/db/schema";

import type { CalendarProvider } from "./types";

export type DriftKind =
  | "event_missing"
  | "meeting_link_lost"
  | "time_mismatch"
  | "external_event";

export type DriftSeverity = "info" | "warn" | "error";

/** Append-only drift record. Idempotent: caller may invoke multiple
 *  times for the same (booking, kind) — each lands its own row, useful
 *  for time-series analysis of recurring drift on the same booking. */
export async function recordDrift(args: {
  tenantId: string;
  provider: CalendarProvider;
  kind: DriftKind;
  severity?: DriftSeverity;
  connectionId?: string | null;
  userId?: string | null;
  bookingId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(syncDriftEvents).values({
      tenantId: args.tenantId,
      connectionId: args.connectionId ?? null,
      userId: args.userId ?? null,
      bookingId: args.bookingId ?? null,
      provider: args.provider,
      kind: args.kind,
      severity: args.severity ?? defaultSeverity(args.kind),
      details: args.details ?? {},
    });
  } catch (err) {
    // Strict never-throw — drift recording must not block sync flows.
    console.error("[calendar/drift] record failed:", err);
  }
}

function defaultSeverity(kind: DriftKind): DriftSeverity {
  if (kind === "event_missing") return "error";
  if (kind === "external_event") return "info";
  return "warn";
}

/**
 * Pick a bounded batch of recently-modified bookings that have an
 * external event id but haven't been drift-scanned in the last
 * `sinceMs` window. The cron passes this list to the per-row scanner.
 *
 * We intentionally don't track a "last_scanned_at" column on bookings
 * (would force frequent UPDATEs on the hot booking table). Instead the
 * cron runs at a sane cadence (every 30 min) and the bounded LIMIT
 * keeps each pass cheap.
 */
export async function pickBookingsForDriftScan(args: {
  limit?: number;
  /** Only scan bookings that start in the next N hours OR happened
   *  in the last 1h (covers freshly-completed slots where the staff
   *  might have moved the event after the meeting). */
  futureHorizonHours?: number;
}): Promise<(typeof bookings.$inferSelect)[]> {
  const limit = Math.min(args.limit ?? 100, 500);
  const horizon = args.futureHorizonHours ?? 48;
  const fromTime = new Date(Date.now() - 60 * 60 * 1000); // 1h back
  const toTime = new Date(Date.now() + horizon * 60 * 60 * 1000);

  return await db.query.bookings.findMany({
    where: and(
      isNotNull(bookings.externalEventId),
      gte(bookings.startAt, fromTime),
      // Use a generic upper bound; SQL planner uses indexed range.
      // We deliberately don't add eq(status,'confirmed') because
      // cancelled bookings with stale externalEventId are valuable
      // drift signals (we should have deleted the provider event).
    ),
    orderBy: [desc(bookings.startAt)],
    limit,
  }).then((rows) => rows.filter((r) => r.startAt.getTime() <= toTime.getTime()));
}

/** Wave E observability — drift rollup per tenant + per kind. */
export type DriftSummary = {
  total: number;
  perKind: Array<{ kind: DriftKind; count: number }>;
  perSeverity: Array<{ severity: DriftSeverity; count: number }>;
  last24h: number;
};

export async function getDriftSummary(tenantId: string): Promise<DriftSummary> {
  try {
    const sinceDay = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        kind: syncDriftEvents.kind,
        severity: syncDriftEvents.severity,
        detectedAt: syncDriftEvents.detectedAt,
      })
      .from(syncDriftEvents)
      .where(eq(syncDriftEvents.tenantId, tenantId));

    const perKind = new Map<DriftKind, number>();
    const perSeverity = new Map<DriftSeverity, number>();
    let last24h = 0;
    for (const r of rows) {
      perKind.set(r.kind as DriftKind, (perKind.get(r.kind as DriftKind) ?? 0) + 1);
      perSeverity.set(r.severity as DriftSeverity, (perSeverity.get(r.severity as DriftSeverity) ?? 0) + 1);
      if (r.detectedAt.getTime() >= sinceDay.getTime()) last24h++;
    }
    return {
      total: rows.length,
      perKind: Array.from(perKind, ([kind, count]) => ({ kind, count })),
      perSeverity: Array.from(perSeverity, ([severity, count]) => ({ severity, count })),
      last24h,
    };
  } catch (err) {
    console.error("[calendar/drift] summary failed:", err);
    return { total: 0, perKind: [], perSeverity: [], last24h: 0 };
  }
}

// Re-export for future scan-callers; the cron script imports this.
export { calendarConnections };

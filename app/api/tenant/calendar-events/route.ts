/**
 * Phase 17I — calendar_events (blocked time + internal meetings).
 *
 *   POST /api/tenant/calendar-events
 *
 * Operational scheduling that blocks staff availability but is NOT
 * customer-facing. Sibling to /api/tenant/appointments (which still
 * owns the customer booking path). Two discriminated shapes:
 *
 *   • blocked_time     — lunch, PTO, focus, tax-season blocking
 *                         (single staff, no attendees, no video)
 *   • internal_meeting — team standups, internal reviews
 *                         (organizer + N staff attendees, optional
 *                          Teams/Meet)
 *
 * Role model (mirrors /api/tenant/appointments):
 *   admin / manager → may target ANY staff in their tenant
 *   staff           → may only target themselves
 *   anyone else     → 403
 *
 * Hard guarantees:
 *   • EXCLUDE constraint calendar_events_no_overlap (migration 0055)
 *     prevents two overlapping events on the same staff_user_id.
 *     Application code adds a soft overlap pre-check against bookings
 *     too — a staff member can't be both delivering a booking AND
 *     blocked at the same instant.
 *   • Sync is fire-and-forget. The organizer's POST returns in ~150ms
 *     regardless of Graph/Google latency. Calendar provider updates
 *     come in later via the orchestrator persisting externalEventId +
 *     meetLink onto the row.
 *
 * No public surface — auth-gated. Cannot create customer-facing rows.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookings,
  calendarEvents,
  users,
} from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { onCalendarEventCreated } from "@/lib/calendar/syncCalendarEvents";
import { createCalendarEventSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await requireUser();
    const ip = ipFromHeaders(req.headers) ?? "anon";
    const body = createCalendarEventSchema.parse(await req.json());

    // ── Role gate ────────────────────────────────────────────────
    if (!["admin", "manager", "staff"].includes(session.role)) {
      throw new HttpError(403, "Not allowed");
    }
    if (session.role === "staff" && body.staffUserId !== session.id) {
      throw new HttpError(
        403,
        "Staff may only create calendar events for themselves",
      );
    }

    // ── Organizer (staffUserId) must be in caller's tenant ──────
    const organizer = await db.query.users.findFirst({
      where: and(
        eq(users.id, body.staffUserId),
        eq(users.tenantId, session.tenantId),
      ),
    });
    if (!organizer) throw new HttpError(404, "Staff not found");

    // ── Time window ─────────────────────────────────────────────
    const startAt = new Date(body.startAt);
    const endAt = new Date(body.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new HttpError(400, "Invalid startAt / endAt");
    }
    if (endAt.getTime() <= startAt.getTime()) {
      // EXCLUDE constraint with tstzrange requires lower < upper.
      // Catch it early with a friendly error instead of a 23P01-style
      // generic conflict.
      throw new HttpError(400, "endAt must be after startAt");
    }

    // ── Internal meeting: validate attendees ────────────────────
    let attendeeRows: typeof users.$inferSelect[] = [];
    if (body.eventType === "internal_meeting" && body.attendeeUserIds.length > 0) {
      // Deduplicate and strip the organizer (the organizer is implicit;
      // adding them as an attendee creates weird "needs response"
      // prompts in Outlook for the staff's own slot).
      const ids = Array.from(
        new Set(body.attendeeUserIds.filter((id) => id !== body.staffUserId)),
      );
      if (ids.length > 0) {
        attendeeRows = await db.query.users.findMany({
          where: and(
            inArray(users.id, ids),
            eq(users.tenantId, session.tenantId),
          ),
        });
        if (attendeeRows.length !== ids.length) {
          throw new HttpError(
            400,
            "One or more attendee users were not found in your workspace",
          );
        }
      }
    }

    // ── Pre-flight overlap pre-check ─────────────────────────────
    // EXCLUDE constraint is the hard backstop on calendar_events vs
    // calendar_events on the same staff. We additionally peek at the
    // bookings table — the organizer can't be both blocked AND
    // delivering a customer booking at the same time. Soft warning;
    // surface a clean 409 instead of a confusing post-insert error.
    const bookingConflict = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, session.tenantId),
          eq(bookings.staffUserId, organizer.id),
          eq(bookings.status, "confirmed"),
          sql`tstzrange(${bookings.startAt}, ${bookings.endAt}) && tstzrange(${startAt}, ${endAt})`,
        ),
      )
      .limit(1);
    if (bookingConflict.length > 0) {
      throw new HttpError(
        409,
        "That staff member already has a customer booking overlapping this window.",
      );
    }

    // ── Insert ───────────────────────────────────────────────────
    let row;
    try {
      [row] = await db
        .insert(calendarEvents)
        .values({
          tenantId: session.tenantId,
          eventType: body.eventType,
          title: body.title,
          startAt,
          endAt,
          allDay: body.allDay,
          staffUserId: organizer.id,
          attendeeUserIds:
            body.eventType === "internal_meeting"
              ? attendeeRows.map((u) => u.id)
              : [],
          notes: body.notes ?? null,
          internalNotes: body.internalNotes ?? null,
          location:
            body.eventType === "internal_meeting" ? body.location ?? null : null,
          videoProvider:
            body.eventType === "internal_meeting"
              ? body.videoProvider ?? null
              : null,
          syncExternal: body.syncExternal,
          createdByUserId: session.id,
        })
        .returning();
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "23P01") {
        throw new HttpError(
          409,
          "Staff already has an overlapping event at that time.",
        );
      }
      throw e;
    }

    // ── Fire-and-forget external sync ────────────────────────────
    // Only push to the connected calendar when the caller opted in.
    // The sync orchestrator (lib/calendar/syncCalendarEvents.ts) is
    // self-contained: own connection-pick, own provider dispatch,
    // own decrypt + token refresh. NEVER throws.
    if (row.syncExternal) {
      const videoProviderHint: "google_meet" | "teams" | null =
        body.eventType === "internal_meeting" && body.videoProvider === "google_meet"
          ? "google_meet"
          : body.eventType === "internal_meeting" && body.videoProvider === "teams"
          ? "teams"
          : null;

      const eventForSync = {
        id: row.id,
        eventType: row.eventType as "blocked_time" | "internal_meeting",
        title: row.title,
        startAt: row.startAt,
        endAt: row.endAt,
        notes: row.notes,
        location: row.location,
        videoProvider: videoProviderHint,
      };

      void onCalendarEventCreated({
        event: eventForSync,
        organizer,
        attendees: attendeeRows,
      })
        .then(async (result) => {
          if (result.status === "ok" && result.externalEventId) {
            await db
              .update(calendarEvents)
              .set({
                externalEventId: result.externalEventId,
                externalEventProvider: result.provider,
                ...(result.meetLink ? { meetLink: result.meetLink } : {}),
                updatedAt: new Date(),
              })
              .where(eq(calendarEvents.id, row.id));
          }
        })
        .catch((bgErr) => {
          console.error(
            "[calendar-events] background sync failed (row kept):",
            bgErr,
          );
        });
    }

    // ── Audit ────────────────────────────────────────────────────
    audit({
      tenantId: session.tenantId,
      actorUserId: session.id,
      action:
        body.eventType === "blocked_time"
          ? "calendar_event.blocked_time_create"
          : "calendar_event.internal_meeting_create",
      entityType: "calendar_event",
      entityId: row.id,
      actorLabel: session.email,
      metadata: {
        eventType: row.eventType,
        staffUserId: organizer.id,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt.toISOString(),
        attendeeCount:
          body.eventType === "internal_meeting" ? attendeeRows.length : 0,
        syncExternal: row.syncExternal,
        videoProvider:
          body.eventType === "internal_meeting"
            ? body.videoProvider ?? null
            : null,
      },
      ipAddress: ip === "anon" ? null : ip,
    });

    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

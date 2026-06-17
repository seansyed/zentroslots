/**
 * Phase 17I-3A — group_sessions (customer-facing group events).
 *
 *   POST /api/tenant/group-sessions
 *
 * One host + many attendees + one shared meeting link. Sibling to
 * /api/tenant/appointments (1:1 bookings) and
 * /api/tenant/calendar-events (operational, non-customer events).
 *
 * Architecture notes:
 *   • group_sessions is its OWN table — never merged with bookings or
 *     calendar_events. v1 stores capacity + meta only; the public
 *     registration flow ships separately (future phase).
 *   • The per-host EXCLUDE constraint
 *     group_sessions_no_host_overlap is the hard backstop against
 *     two overlapping sessions on the same host slot. We also
 *     pre-check against bookings + calendar_events + group_sessions
 *     so the operator sees a clean 409 instead of a 23P01 surprise.
 *   • Fire-and-forget external sync — admin's POST returns in ~200ms;
 *     Graph/Google latency stays out of the request.
 *
 * Role model (mirrors the appointments + calendar-events routes):
 *   admin / manager → may host ANY staff
 *   staff           → may only host themselves
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookings,
  calendarEvents,
  groupSessions,
  services,
  users,
} from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { onGroupSessionCreated } from "@/lib/calendar/syncCalendarEvents";
import { createGroupSessionSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await requireUser();
    const ip = ipFromHeaders(req.headers) ?? "anon";
    const body = createGroupSessionSchema.parse(await req.json());

    // ── Role gate ────────────────────────────────────────────────
    if (!["admin", "manager", "staff"].includes(session.role)) {
      throw new HttpError(403, "Not allowed");
    }
    if (session.role === "staff" && body.hostUserId !== session.id) {
      throw new HttpError(
        403,
        "Staff may only host group sessions for themselves",
      );
    }

    // ── Host: exists + same tenant ───────────────────────────────
    const host = await db.query.users.findFirst({
      where: and(
        eq(users.id, body.hostUserId),
        eq(users.tenantId, session.tenantId),
      ),
    });
    if (!host) throw new HttpError(404, "Host not found");

    // ── Optional service: validate tenant ownership ──────────────
    let serviceId: string | null = null;
    if (body.serviceId) {
      const service = await db.query.services.findFirst({
        where: and(
          eq(services.id, body.serviceId),
          eq(services.tenantId, session.tenantId),
        ),
      });
      if (!service) throw new HttpError(404, "Service not found");
      serviceId = service.id;
    }

    // ── Time window ──────────────────────────────────────────────
    const startAt = new Date(body.startAt);
    const endAt = new Date(body.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new HttpError(400, "Invalid startAt / endAt");
    }
    if (endAt.getTime() <= startAt.getTime()) {
      throw new HttpError(400, "endAt must be after startAt");
    }

    // Optional registration deadline — must be in the past relative
    // to the session start (cutoff fires before the event begins).
    let registrationDeadline: Date | null = null;
    if (body.registrationDeadline) {
      const rd = new Date(body.registrationDeadline);
      if (Number.isNaN(rd.getTime())) {
        throw new HttpError(400, "Invalid registrationDeadline");
      }
      if (rd.getTime() > startAt.getTime()) {
        throw new HttpError(
          400,
          "registrationDeadline must be before the session start",
        );
      }
      registrationDeadline = rd;
    }

    // ── Pre-flight overlap checks on the host ────────────────────
    // EXCLUDE constraint on group_sessions is the hard backstop. We
    // also check bookings + calendar_events so the operator gets a
    // single clean 409 rather than discovering the conflict via DB
    // failure modes.
    const bookingConflict = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, session.tenantId),
          eq(bookings.staffUserId, host.id),
          eq(bookings.status, "confirmed"),
          // ISO + ::timestamptz cast — never hand a raw JS Date to a raw-sql
          // param (postgres.js Buffer.byteLength(Date) throws). See the
          // matching fix in app/api/tenant/appointments/route.ts.
          sql`tstzrange(${bookings.startAt}, ${bookings.endAt}) && tstzrange(${startAt.toISOString()}::timestamptz, ${endAt.toISOString()}::timestamptz)`,
        ),
      )
      .limit(1);
    if (bookingConflict.length > 0) {
      throw new HttpError(
        409,
        "Host has a customer booking overlapping this window.",
      );
    }
    const eventConflict = await db
      .select({ id: calendarEvents.id })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.tenantId, session.tenantId),
          eq(calendarEvents.staffUserId, host.id),
          // ISO + ::timestamptz cast — see the matching fix above / in
          // app/api/tenant/appointments/route.ts.
          sql`tstzrange(${calendarEvents.startAt}, ${calendarEvents.endAt}) && tstzrange(${startAt.toISOString()}::timestamptz, ${endAt.toISOString()}::timestamptz)`,
        ),
      )
      .limit(1);
    if (eventConflict.length > 0) {
      throw new HttpError(
        409,
        "Host has a blocked time or internal meeting overlapping this window.",
      );
    }

    // ── Insert ───────────────────────────────────────────────────
    let row;
    try {
      [row] = await db
        .insert(groupSessions)
        .values({
          tenantId: session.tenantId,
          title: body.title,
          serviceId,
          hostUserId: host.id,
          startAt,
          endAt,
          maxCapacity: body.maxCapacity,
          videoProvider: body.videoProvider ?? null,
          location: body.location ?? null,
          notes: body.notes ?? null,
          internalNotes: body.internalNotes ?? null,
          registrationDeadline,
          syncExternal: body.syncExternal,
          status: "scheduled",
          createdByUserId: session.id,
        })
        .returning();
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "23P01") {
        throw new HttpError(
          409,
          "Host already has an overlapping group session at that time.",
        );
      }
      throw e;
    }

    // ── Fire-and-forget external sync ────────────────────────────
    if (row.syncExternal) {
      const videoProviderHint: "google_meet" | "teams" | "zoom" | null =
        body.videoProvider === "google_meet"
          ? "google_meet"
          : body.videoProvider === "teams"
          ? "teams"
          : body.videoProvider === "zoom"
          ? "zoom"
          : null;

      void onGroupSessionCreated({
        session: {
          id: row.id,
          title: row.title,
          startAt: row.startAt,
          endAt: row.endAt,
          notes: row.notes,
          location: row.location,
          videoProvider: videoProviderHint,
        },
        host,
      })
        .then(async (result) => {
          if (result.status === "ok" && result.externalEventId) {
            await db
              .update(groupSessions)
              .set({
                externalEventId: result.externalEventId,
                externalEventProvider: result.provider,
                ...(result.meetLink ? { meetLink: result.meetLink } : {}),
                updatedAt: new Date(),
              })
              .where(eq(groupSessions.id, row.id));
          }
        })
        .catch((bgErr) => {
          console.error(
            "[group-sessions] background sync failed (row kept):",
            bgErr,
          );
        });
    }

    // ── Audit ────────────────────────────────────────────────────
    audit({
      tenantId: session.tenantId,
      actorUserId: session.id,
      action: "group_session.create",
      entityType: "group_session",
      entityId: row.id,
      actorLabel: session.email,
      metadata: {
        hostUserId: host.id,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt.toISOString(),
        maxCapacity: row.maxCapacity,
        videoProvider: body.videoProvider ?? null,
        syncExternal: row.syncExternal,
        serviceId: row.serviceId,
      },
      ipAddress: ip === "anon" ? null : ip,
    });

    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

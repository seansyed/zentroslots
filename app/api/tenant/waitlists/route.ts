import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import {
  services,
  waitlists,
  waitlistNotifications,
} from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";

// GET /api/tenant/waitlists
//
// Returns all waitlist entries + recent notifications for the
// caller-tenant. Powers the admin UI. Tenant-isolated.
export async function GET(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const statusFilter = req.nextUrl.searchParams.get("status");

    const conds = [eq(waitlists.tenantId, admin.tenantId)];
    if (statusFilter && ["waiting", "notified", "claimed", "expired", "cancelled"].includes(statusFilter)) {
      conds.push(eq(waitlists.status, statusFilter));
    }

    const [entries, recentNotifs, svcList] = await Promise.all([
      db
        .select({
          id: waitlists.id,
          serviceId: waitlists.serviceId,
          customerEmail: waitlists.customerEmail,
          customerName: waitlists.customerName,
          customerPhone: waitlists.customerPhone,
          preferredDate: waitlists.preferredDate,
          preferredTimeRange: waitlists.preferredTimeRange,
          status: waitlists.status,
          priority: waitlists.priority,
          expiresAt: waitlists.expiresAt,
          claimedAt: waitlists.claimedAt,
          claimedBookingId: waitlists.claimedBookingId,
          createdAt: waitlists.createdAt,
          serviceName: services.name,
        })
        .from(waitlists)
        .leftJoin(services, eq(services.id, waitlists.serviceId))
        .where(and(...conds))
        .orderBy(asc(waitlists.priority), asc(waitlists.createdAt))
        .limit(200),
      db
        .select()
        .from(waitlistNotifications)
        .where(eq(waitlistNotifications.tenantId, admin.tenantId))
        .orderBy(desc(waitlistNotifications.createdAt))
        .limit(50),
      db
        .select({ id: services.id, name: services.name, slug: services.slug })
        .from(services)
        .where(and(eq(services.tenantId, admin.tenantId), eq(services.isActive, 1)))
        .orderBy(asc(services.name)),
    ]);

    return NextResponse.json({ entries, notifications: recentNotifs, services: svcList });
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── PATCH /api/tenant/waitlists  — admin actions ─────────────────────
// Body: { id, action: "cancel" | "expire_hold" | "manual_promote" }
// - cancel: status → 'cancelled' (remove from queue)
// - expire_hold: flip any active notification → 'expired', return entry to 'waiting'
// - manual_promote: reserved (release-orchestrator already handles
//                   promotion; admin promotion would need a target slot)
const patchSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["cancel", "expire_hold"]),
});

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const body = patchSchema.parse(await req.json());

    const row = await db.query.waitlists.findFirst({
      where: and(eq(waitlists.id, body.id), eq(waitlists.tenantId, admin.tenantId)),
    });
    if (!row) throw new HttpError(404, "Waitlist entry not found");

    if (body.action === "cancel") {
      await db
        .update(waitlists)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(waitlists.id, row.id));
      // Any active notifications also expire — they're no longer valid.
      await db
        .update(waitlistNotifications)
        .set({ status: "expired", respondedAt: new Date() })
        .where(
          and(
            eq(waitlistNotifications.waitlistId, row.id),
            eq(waitlistNotifications.status, "sent")
          )
        );
      audit({
        tenantId: admin.tenantId,
        action: "waitlist.cancel",
        actorUserId: admin.id,
        actorLabel: admin.email,
        entityType: "waitlist",
        entityId: row.id,
        metadata: { serviceId: row.serviceId },
        ipAddress: ipFromHeaders(req.headers),
      });
    } else if (body.action === "expire_hold") {
      // Force-expire the active notification, return entry to waiting.
      await db
        .update(waitlistNotifications)
        .set({ status: "expired", respondedAt: new Date() })
        .where(
          and(
            eq(waitlistNotifications.waitlistId, row.id),
            eq(waitlistNotifications.status, "sent")
          )
        );
      await db
        .update(waitlists)
        .set({ status: "waiting", expiresAt: null, updatedAt: new Date() })
        .where(and(eq(waitlists.id, row.id), eq(waitlists.status, "notified")));
      audit({
        tenantId: admin.tenantId,
        action: "waitlist.expire_hold",
        actorUserId: admin.id,
        actorLabel: admin.email,
        entityType: "waitlist",
        entityId: row.id,
        metadata: { serviceId: row.serviceId },
        ipAddress: ipFromHeaders(req.headers),
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

// sql for future filtering helpers
void sql;

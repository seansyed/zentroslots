import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { assertCanAddManager } from "@/lib/quotas";
import { audit, ipFromHeaders } from "@/lib/audit";

// Admin-only. Promotes/demotes a workspace user between staff ↔ manager.
// Deliberately does NOT support changing to 'admin' (one path for that —
// signup) or to 'client'. Has three safety gates:
//   1. Caller must be admin (managers cannot reshuffle the org chart).
//   2. Target user must already be staff or manager (no promoting clients).
//   3. Caller cannot change their own role (prevents lockout).
const patchSchema = z.object({
  role: z.enum(["staff", "manager"]),
});

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requireRole(["admin"]);
    const { id } = await context.params;
    const { role: newRole } = patchSchema.parse(await req.json());

    if (id === caller.id) {
      throw new HttpError(409, "You can't change your own role — ask another admin.");
    }

    const target = await db.query.users.findFirst({
      where: and(
        eq(users.id, id),
        eq(users.tenantId, caller.tenantId),
        inArray(users.role, ["staff", "manager"])
      ),
    });
    if (!target) throw new HttpError(404, "User not found in this workspace, or role can't be changed.");

    if (target.role === newRole) {
      // No-op — return current state without writing/auditing.
      return NextResponse.json({ ok: true, role: target.role, changed: false });
    }

    // Only check the seat quota on PROMOTIONS (staff → manager).
    // Demotions free a seat so they never block.
    if (newRole === "manager" && target.role !== "manager") {
      await assertCanAddManager(caller.tenantId);
    }

    const [updated] = await db
      .update(users)
      .set({ role: newRole, updatedAt: new Date() })
      .where(and(eq(users.id, id), eq(users.tenantId, caller.tenantId)))
      .returning({ id: users.id, role: users.role });

    audit({
      tenantId: caller.tenantId,
      action: "user.role.change",
      actorUserId: caller.id,
      actorLabel: caller.email,
      entityType: "user",
      entityId: id,
      metadata: { from: target.role, to: newRole, targetEmail: target.email },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({ ok: true, role: updated.role, changed: true });
  } catch (err) {
    return errorResponse(err);
  }
}

// Last-resort safety: explicitly block other methods. NextRequest's
// default behavior would 405 on its own; the explicit handler makes the
// surface unambiguous.
export async function GET() {
  return NextResponse.json({ error: "Use POST" }, { status: 405 });
}

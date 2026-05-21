import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { services } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { simulateAssignment } from "@/lib/routing/simulate";

/**
 * POST /api/tenant/routing/simulate
 *
 * Stateless what-if dry run of the routing engine. Calls the same
 * eligibility primitives the real booking POST would call — same
 * working-hours check, same internal conflict scan, same external
 * Google busy scan, same picker. Returns the full reasoning trail
 * per candidate. Never writes; never affects assignment stats.
 *
 * Admin/manager only.
 */
const bodySchema = z.object({
  serviceId: z.string().uuid(),
  /** ISO timestamp the customer would have asked for. */
  startAt: z.string().min(1),
  /** Optional explicit duration (minutes). Defaults to the service's
   *  configured durationMinutes. */
  durationMinutes: z.number().int().positive().max(8 * 60).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const body = bodySchema.parse(await req.json());

    // Resolve service to enforce tenant isolation + derive duration.
    const service = await db.query.services.findFirst({
      where: eq(services.id, body.serviceId),
    });
    if (!service) throw new HttpError(404, "Service not found");
    if (service.tenantId !== admin.tenantId) {
      throw new HttpError(403, "Cross-tenant access denied");
    }

    const startAt = new Date(body.startAt);
    if (Number.isNaN(startAt.getTime())) {
      throw new HttpError(400, "Invalid startAt");
    }
    const durationMinutes = body.durationMinutes ?? service.durationMinutes;
    const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);

    const result = await simulateAssignment({
      tenantId: admin.tenantId,
      serviceId: service.id,
      startAt,
      endAt,
    });

    return NextResponse.json({
      ok: true,
      requested: {
        serviceId: service.id,
        serviceName: service.name,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        durationMinutes,
      },
      ...result,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

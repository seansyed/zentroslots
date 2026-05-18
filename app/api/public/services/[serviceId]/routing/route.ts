import { NextResponse } from "next/server";
import { and, eq, isNull, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { services, staffAssignmentRules } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";

// GET /api/public/services/:serviceId/routing
//
// Public, unauthenticated. Returns ONLY the user-facing intent of the
// routing config for this service — not the rule config itself. Used
// by the public booking page to decide whether to show "Next available
// specialist" instead of a specific staff name.
//
// Response shape (frozen — clients may rely on it):
//   { mode: "manual" | "auto", message?: string }
//
// "auto" covers all non-manual modes (round_robin, least_busy,
// priority, weighted). The customer doesn't need to know which.
export async function GET(
  _req: Request,
  context: { params: Promise<{ serviceId: string }> }
) {
  try {
    const { serviceId } = await context.params;

    const service = await db.query.services.findFirst({
      where: eq(services.id, serviceId),
    });
    if (!service || service.isActive !== 1) {
      throw new HttpError(404, "Service not found");
    }

    // Apply specificity: service-specific rule wins over tenant default.
    const candidates = await db
      .select()
      .from(staffAssignmentRules)
      .where(
        and(
          eq(staffAssignmentRules.tenantId, service.tenantId),
          or(
            eq(staffAssignmentRules.serviceId, serviceId),
            and(
              isNull(staffAssignmentRules.serviceId),
              isNull(staffAssignmentRules.locationId)
            )
          )
        )
      );

    // Pick service-specific > tenant default.
    const winner =
      candidates.find((r) => r.serviceId === serviceId) ??
      candidates.find((r) => r.serviceId === null && r.locationId === null) ??
      null;

    if (!winner || !winner.enabled || winner.mode === "manual") {
      return NextResponse.json({ mode: "manual" });
    }

    return NextResponse.json({
      mode: "auto",
      message: "Next available specialist",
    });
  } catch (err) {
    return errorResponse(err);
  }
}

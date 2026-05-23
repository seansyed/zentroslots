/**
 * Wave I — which services use this form + submission count snapshot.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { intakeForms, services } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";

export const dynamic = "force-dynamic";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["admin", "manager"]);
    const { id } = await context.params;
    if (!id || !UUID_RE.test(id)) throw new HttpError(404, "Not found");

    const form = await db.query.intakeForms.findFirst({
      where: and(eq(intakeForms.id, id), eq(intakeForms.tenantId, user.tenantId)),
      columns: { submissionCount: true },
    });
    if (!form) throw new HttpError(404, "Not found");

    const linkedServices = await db
      .select({
        id: services.id,
        name: services.name,
        slug: services.slug,
        isActive: services.isActive,
      })
      .from(services)
      .where(and(eq(services.tenantId, user.tenantId), eq(services.intakeFormId, id)));

    return NextResponse.json({
      submissionCount: form.submissionCount,
      services: linkedServices,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

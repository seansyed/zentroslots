/**
 * Wave I — admin intake forms API: list + create.
 *
 *   GET  /api/tenant/intake-forms       — list all forms for tenant
 *   POST /api/tenant/intake-forms       — create new form (plan-gated)
 */

import { NextRequest, NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { intakeForms, services, tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { audit, ipFromHeaders } from "@/lib/audit";
import {
  assertFormFitsPlan,
  intakeFormSchema,
} from "@/lib/intake";
import { resolveIntakeLimits } from "@/lib/plans/intakeLimits";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireRole(["admin", "manager"]);
    const rows = await db
      .select({
        id: intakeForms.id,
        name: intakeForms.name,
        description: intakeForms.description,
        fields: intakeForms.fields,
        isActive: intakeForms.isActive,
        submissionCount: intakeForms.submissionCount,
        createdAt: intakeForms.createdAt,
        updatedAt: intakeForms.updatedAt,
      })
      .from(intakeForms)
      .where(eq(intakeForms.tenantId, user.tenantId))
      .orderBy(desc(intakeForms.updatedAt));

    // Each form: count of services linked to it (for the "Used by N
    // services" badge). One small aggregate query, no N+1.
    const usageRows = await db
      .select({
        intakeFormId: services.intakeFormId,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(services)
      .where(eq(services.tenantId, user.tenantId))
      .groupBy(services.intakeFormId);
    const usageMap = new Map(
      usageRows
        .filter((r) => r.intakeFormId !== null)
        .map((r) => [r.intakeFormId as string, r.count]),
    );

    return NextResponse.json({
      forms: rows.map((r) => ({
        ...r,
        usedByServicesCount: usageMap.get(r.id) ?? 0,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireRole(["admin"]);
    const body = intakeFormSchema.parse(await req.json());

    // Plan-gating BEFORE the insert. resolveIntakeLimits reads the
    // tenant's current plan; assertFormFitsPlan throws a user-friendly
    // error which the catch block converts to 402.
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, user.tenantId),
      columns: { currentPlan: true },
    });
    const limits = resolveIntakeLimits(tenant?.currentPlan);
    try {
      assertFormFitsPlan(body, limits);
    } catch (e) {
      throw new HttpError(402, e instanceof Error ? e.message : "Plan limit");
    }

    const [row] = await db
      .insert(intakeForms)
      .values({
        tenantId: user.tenantId,
        name: body.name,
        description: body.description ?? null,
        fields: body.fields,
        isActive: body.isActive,
      })
      .returning();

    audit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "intake_form.create",
      entityType: "intake_form",
      entityId: row.id,
      metadata: { name: row.name, fieldCount: body.fields.length },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({ form: row });
  } catch (err) {
    return errorResponse(err);
  }
}

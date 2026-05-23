/**
 * Wave I — duplicate an existing form.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { intakeForms, tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { audit, ipFromHeaders } from "@/lib/audit";
import { assertFormFitsPlan, intakeFormSchema, type IntakeField } from "@/lib/intake";
import { resolveIntakeLimits } from "@/lib/plans/intakeLimits";

export const dynamic = "force-dynamic";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["admin"]);
    const { id } = await context.params;
    if (!id || !UUID_RE.test(id)) throw new HttpError(404, "Not found");

    const source = await db.query.intakeForms.findFirst({
      where: and(eq(intakeForms.id, id), eq(intakeForms.tenantId, user.tenantId)),
    });
    if (!source) throw new HttpError(404, "Not found");

    // Re-validate against the canonical schema (the source row may
    // contain legacy field types — those are accepted by the schema).
    const validated = intakeFormSchema.parse({
      name: `${source.name} (copy)`,
      description: source.description ?? undefined,
      fields: source.fields as IntakeField[],
      isActive: source.isActive,
    });

    // Plan-gate the copy — duplicating onto a downgraded plan could
    // exceed the cap.
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, user.tenantId),
      columns: { currentPlan: true },
    });
    const limits = resolveIntakeLimits(tenant?.currentPlan);
    try {
      assertFormFitsPlan(validated, limits);
    } catch (e) {
      throw new HttpError(402, e instanceof Error ? e.message : "Plan limit");
    }

    const [row] = await db
      .insert(intakeForms)
      .values({
        tenantId: user.tenantId,
        name: validated.name.slice(0, 120),
        description: validated.description ?? null,
        fields: validated.fields,
        isActive: false, // duplicate starts disabled — explicit re-enable
      })
      .returning();

    audit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "intake_form.duplicate",
      entityType: "intake_form",
      entityId: row.id,
      metadata: { sourceId: id, fieldCount: validated.fields.length },
      ipAddress: ipFromHeaders(req.headers),
    });
    return NextResponse.json({ form: row });
  } catch (err) {
    return errorResponse(err);
  }
}

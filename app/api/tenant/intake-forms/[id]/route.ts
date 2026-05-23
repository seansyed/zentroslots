/**
 * Wave I — single intake form: get / patch / delete.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { intakeForms, services, tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { audit, ipFromHeaders } from "@/lib/audit";
import { assertFormFitsPlan, intakeFormSchema } from "@/lib/intake";
import { resolveIntakeLimits } from "@/lib/plans/intakeLimits";

export const dynamic = "force-dynamic";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateId(id: string | undefined): string {
  if (!id || !UUID_RE.test(id)) throw new HttpError(404, "Not found");
  return id;
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["admin", "manager"]);
    const { id } = await context.params;
    const validId = validateId(id);
    const row = await db.query.intakeForms.findFirst({
      where: and(eq(intakeForms.id, validId), eq(intakeForms.tenantId, user.tenantId)),
    });
    if (!row) throw new HttpError(404, "Not found");
    return NextResponse.json({ form: row });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["admin"]);
    const { id } = await context.params;
    const validId = validateId(id);
    const body = intakeFormSchema.partial().parse(await req.json());

    // Re-fetch + plan-gate on the resulting field set (not just the
    // delta) so a "patch one field" that pushes over the cap is rejected.
    const existing = await db.query.intakeForms.findFirst({
      where: and(
        eq(intakeForms.id, validId),
        eq(intakeForms.tenantId, user.tenantId),
      ),
    });
    if (!existing) throw new HttpError(404, "Not found");

    const merged = {
      name: body.name ?? existing.name,
      description: body.description ?? existing.description ?? undefined,
      fields: body.fields ?? (existing.fields as unknown as never),
      isActive: body.isActive ?? existing.isActive,
    };
    // Re-validate the merged form against the canonical schema.
    const validated = intakeFormSchema.parse(merged);

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, user.tenantId),
      columns: { currentPlan: true },
    });
    const limits = resolveIntakeLimits(tenant?.currentPlan);

    // Grandfathering: only enforce the plan limit when the new field
    // count INCREASES. Tenants on downgrade can edit existing forms
    // (e.g. fix a typo) without being forced to delete fields.
    const newCount = validated.fields.length;
    const oldCount = Array.isArray(existing.fields)
      ? (existing.fields as unknown as unknown[]).length
      : 0;
    if (newCount > oldCount) {
      try {
        assertFormFitsPlan(validated, limits);
      } catch (e) {
        throw new HttpError(402, e instanceof Error ? e.message : "Plan limit");
      }
    }

    const [row] = await db
      .update(intakeForms)
      .set({
        name: validated.name,
        description: validated.description ?? null,
        fields: validated.fields,
        isActive: validated.isActive,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(intakeForms.id, validId),
          eq(intakeForms.tenantId, user.tenantId),
        ),
      )
      .returning();

    audit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "intake_form.update",
      entityType: "intake_form",
      entityId: validId,
      metadata: { fieldCount: validated.fields.length },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({ form: row });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["admin"]);
    const { id } = await context.params;
    const validId = validateId(id);

    // Refuse delete if active services link to this form. Force tenant
    // to unlink first — prevents accidental data loss + orphan refs.
    const linked = await db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(services)
      .where(
        and(
          eq(services.tenantId, user.tenantId),
          eq(services.intakeFormId, validId),
        ),
      );
    if ((linked[0]?.c ?? 0) > 0) {
      throw new HttpError(
        409,
        "This form is attached to one or more services. Unlink it first.",
      );
    }

    const res = await db
      .delete(intakeForms)
      .where(
        and(
          eq(intakeForms.id, validId),
          eq(intakeForms.tenantId, user.tenantId),
        ),
      )
      .returning({ id: intakeForms.id });
    if (res.length === 0) throw new HttpError(404, "Not found");

    audit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "intake_form.delete",
      entityType: "intake_form",
      entityId: validId,
      ipAddress: ipFromHeaders(req.headers),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

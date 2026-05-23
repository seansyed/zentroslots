/**
 * Wave I — public render-ready intake form for a service.
 *
 *   GET /api/public/services/<id>/intake-form
 *
 * Used by the customer booking flow's Intake step. Returns ONLY:
 *   • field definitions (label, type, required, options, help text)
 *   • form name + description
 *
 * Never returns submissionCount, tenant id, or any admin metadata.
 * Tenant feature flag respected — if intakeForms feature is disabled
 * at the tenant level, returns { form: null } so the booking flow can
 * skip the step (existing gate, preserved).
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { intakeForms, services, tenants } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { canonicalType, type IntakeField } from "@/lib/intake";
import { loadTenantFeatures } from "@/lib/features";

export const dynamic = "force-dynamic";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!id || !UUID_RE.test(id)) throw new HttpError(404, "Not found");

    const service = await db.query.services.findFirst({
      where: eq(services.id, id),
      columns: {
        id: true,
        tenantId: true,
        intakeFormId: true,
        isActive: true,
      },
    });
    if (!service || service.isActive !== 1) {
      throw new HttpError(404, "Not found");
    }
    if (!service.intakeFormId) {
      return NextResponse.json({ form: null });
    }

    // Tenant-level feature flag must be on.
    const features = await loadTenantFeatures(service.tenantId);
    if (!features.intakeForms) {
      return NextResponse.json({ form: null });
    }

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, service.tenantId),
      columns: { id: true },
    });
    if (!tenant) {
      return NextResponse.json({ form: null });
    }

    const form = await db.query.intakeForms.findFirst({
      where: and(
        eq(intakeForms.id, service.intakeFormId),
        eq(intakeForms.tenantId, service.tenantId),
      ),
    });
    if (!form || !form.isActive) {
      return NextResponse.json({ form: null });
    }

    // Strip any admin-only fields (none currently, but defensive).
    // Canonicalize type names so the renderer can ignore legacy aliases.
    const rawFields = (form.fields as IntakeField[]) ?? [];
    const cleanFields = rawFields
      .map((f) => ({
        key: f.key,
        label: f.label,
        type: canonicalType(f.type),
        required: f.required ?? false,
        helpText: f.helpText ?? f.help,
        placeholder: f.placeholder,
        options: f.options,
        min: f.min,
        max: f.max,
        order: f.order,
        consentText: f.consentText,
        consentLinkUrl: f.consentLinkUrl,
        consentLinkLabel: f.consentLinkLabel,
        defaultValue: f.defaultValue,
      }))
      .sort((a, b) => {
        const ao = a.order ?? 0;
        const bo = b.order ?? 0;
        return ao - bo;
      });

    return NextResponse.json({
      form: {
        id: form.id,
        name: form.name,
        description: form.description ?? null,
        fields: cleanFields,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

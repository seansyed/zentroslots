import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { communicationTemplates, services } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { TEMPLATE_TYPES, templateStarterFor, type TemplateType } from "@/lib/communications/templates";
import { audit, ipFromHeaders } from "@/lib/audit";

// GET    /api/tenant/communications/templates[?serviceId=...]
// PUT    /api/tenant/communications/templates
// DELETE /api/tenant/communications/templates?type=...&[serviceId=...]
//
// Two scopes share the same shape:
//   - Business-wide (serviceId omitted / null) — existing behavior
//   - Service-specific (serviceId provided)    — service-level overrides
//
// In service scope, the GET response includes the inheritance source:
// service / tenant / system. The PUT body's optional serviceId controls
// where the row lands. Service ownership is validated against the
// caller's tenant on every write/delete; cross-tenant ids are rejected.

const upsertSchema = z.object({
  templateType: z.enum(TEMPLATE_TYPES as unknown as [string, ...string[]]),
  // Optional. When present, upsert is service-scoped; when absent or
  // null, business-wide (matches pre-existing behavior).
  serviceId: z.string().uuid().nullable().optional(),
  subject: z.string().max(500).nullable(),
  htmlContent: z.string().max(50_000).nullable(),
  textContent: z.string().max(20_000).nullable(),
  enabled: z.boolean(),
});

async function assertServiceInTenant(serviceId: string, tenantId: string): Promise<void> {
  const svc = await db.query.services.findFirst({
    where: and(eq(services.id, serviceId), eq(services.tenantId, tenantId)),
  });
  if (!svc) throw new HttpError(404, "Service not found in workspace");
}

export async function GET(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const serviceIdParam = req.nextUrl.searchParams.get("serviceId");

    // ── Business-wide scope (additive: now includes a count of how
    //   many services override each template type, so the list UI can
    //   show "Used by N services"). Backward-compatible: the existing
    //   shape is preserved and the new field is additive. ──────────
    if (!serviceIdParam) {
      const [rows, overrideCounts] = await Promise.all([
        db
          .select()
          .from(communicationTemplates)
          .where(
            and(
              eq(communicationTemplates.tenantId, admin.tenantId),
              isNull(communicationTemplates.serviceId)
            )
          ),
        db
          .select({
            templateType: communicationTemplates.templateType,
            count: sql<number>`count(*)::int`,
          })
          .from(communicationTemplates)
          .where(
            and(
              eq(communicationTemplates.tenantId, admin.tenantId),
              eq(communicationTemplates.channel, "email"),
              // service_id IS NOT NULL — only overrides count.
              sql`${communicationTemplates.serviceId} IS NOT NULL`
            )
          )
          .groupBy(communicationTemplates.templateType),
      ]);

      const byType = new Map(rows.map((r) => [r.templateType, r]));
      const overrideByType = new Map(overrideCounts.map((r) => [r.templateType, r.count]));

      return NextResponse.json(
        TEMPLATE_TYPES.map((type) => {
          const overridingServices = overrideByType.get(type) ?? 0;
          const row = byType.get(type);
          if (row) {
            return {
              templateType: type,
              scope: "business" as const,
              source: "tenant" as const,
              isCustomized: true,
              subject: row.subject ?? "",
              htmlContent: row.htmlContent ?? "",
              textContent: row.textContent ?? "",
              enabled: row.enabled,
              updatedAt: row.updatedAt,
              overridingServiceCount: overridingServices,
            };
          }
          const starter = templateStarterFor(type);
          return {
            templateType: type,
            scope: "business" as const,
            source: "system" as const,
            isCustomized: false,
            subject: starter.subject,
            htmlContent: starter.html,
            textContent: starter.text,
            enabled: true,
            updatedAt: null,
            overridingServiceCount: overridingServices,
          };
        })
      );
    }

    // ── Service-scoped: load both service rows and the tenant defaults,
    // and present an inheritance-aware view for each type. ────────────
    await assertServiceInTenant(serviceIdParam, admin.tenantId);

    const [serviceRows, tenantRows] = await Promise.all([
      db
        .select()
        .from(communicationTemplates)
        .where(
          and(
            eq(communicationTemplates.tenantId, admin.tenantId),
            eq(communicationTemplates.serviceId, serviceIdParam)
          )
        ),
      db
        .select()
        .from(communicationTemplates)
        .where(
          and(
            eq(communicationTemplates.tenantId, admin.tenantId),
            isNull(communicationTemplates.serviceId)
          )
        ),
    ]);

    const byService = new Map(serviceRows.map((r) => [r.templateType, r]));
    const byTenant = new Map(tenantRows.map((r) => [r.templateType, r]));

    return NextResponse.json(
      TEMPLATE_TYPES.map((type) => {
        const svcRow = byService.get(type);
        const tenantRow = byTenant.get(type);
        // The resolver requires `enabled=true` on the service row to
        // honor it; disabled rows fall through to tenant/system. The
        // editor must reflect that — same source semantics.
        if (svcRow && svcRow.enabled) {
          return {
            templateType: type,
            scope: "service" as const,
            source: "service" as const,
            isCustomized: true,
            subject: svcRow.subject ?? "",
            htmlContent: svcRow.htmlContent ?? "",
            textContent: svcRow.textContent ?? "",
            enabled: svcRow.enabled,
            updatedAt: svcRow.updatedAt,
            // When inherited would be: which tenant row this would fall
            // back to. Useful for the "view inherited" affordance.
            inheritedSubject: tenantRow?.subject ?? null,
            inheritedHtml: tenantRow?.htmlContent ?? null,
            inheritedText: tenantRow?.textContent ?? null,
          };
        }

        // Inherited path — show the tenant row (or system fallback).
        if (tenantRow) {
          return {
            templateType: type,
            scope: "service" as const,
            source: "tenant" as const,
            isCustomized: false,
            subject: tenantRow.subject ?? "",
            htmlContent: tenantRow.htmlContent ?? "",
            textContent: tenantRow.textContent ?? "",
            enabled: tenantRow.enabled,
            updatedAt: tenantRow.updatedAt,
          };
        }

        const starter = templateStarterFor(type);
        return {
          templateType: type,
          scope: "service" as const,
          source: "system" as const,
          isCustomized: false,
          subject: starter.subject,
          htmlContent: starter.html,
          textContent: starter.text,
          enabled: true,
          updatedAt: null,
        };
      })
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const body = upsertSchema.parse(await req.json());
    const templateType = body.templateType as TemplateType;
    const serviceId = body.serviceId ?? null;

    if (serviceId) {
      await assertServiceInTenant(serviceId, admin.tenantId);
    }

    // Tenant-wide vs service-scoped have separate unique constraints in
    // the DB (partial indexes on serviceId IS NULL vs IS NOT NULL). The
    // findFirst here uses the same predicate so we hit the matching row.
    const existing = await db.query.communicationTemplates.findFirst({
      where: and(
        eq(communicationTemplates.tenantId, admin.tenantId),
        serviceId
          ? eq(communicationTemplates.serviceId, serviceId)
          : isNull(communicationTemplates.serviceId),
        eq(communicationTemplates.templateType, templateType),
        eq(communicationTemplates.channel, "email")
      ),
    });

    let row;
    if (existing) {
      [row] = await db
        .update(communicationTemplates)
        .set({
          subject: body.subject,
          htmlContent: body.htmlContent,
          textContent: body.textContent,
          enabled: body.enabled,
          updatedAt: new Date(),
        })
        .where(eq(communicationTemplates.id, existing.id))
        .returning();
    } else {
      [row] = await db
        .insert(communicationTemplates)
        .values({
          tenantId: admin.tenantId,
          serviceId,
          templateType,
          channel: "email",
          subject: body.subject,
          htmlContent: body.htmlContent,
          textContent: body.textContent,
          enabled: body.enabled,
        })
        .returning();
    }

    audit({
      tenantId: admin.tenantId,
      action: serviceId ? "comm_template.service_update" : "comm_template.update",
      actorUserId: admin.id,
      actorLabel: admin.email,
      entityType: "communication_template",
      entityId: row.id,
      metadata: { templateType, serviceId, enabled: row.enabled },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({ ok: true, id: row.id });
  } catch (err) {
    return errorResponse(err);
  }
}

// DELETE /api/tenant/communications/templates?type=X[&serviceId=Y]
//   - Without serviceId → restore business-wide default (drops tenant
//     row; falls back to system).
//   - With serviceId    → restore inherited (drops service-level row;
//     falls back to tenant row, then system).
export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const type = req.nextUrl.searchParams.get("type");
    const serviceIdParam = req.nextUrl.searchParams.get("serviceId");
    if (!type || !(TEMPLATE_TYPES as readonly string[]).includes(type)) {
      throw new HttpError(400, "Unknown template type");
    }
    if (serviceIdParam) {
      await assertServiceInTenant(serviceIdParam, admin.tenantId);
    }

    const deleted = await db
      .delete(communicationTemplates)
      .where(
        and(
          eq(communicationTemplates.tenantId, admin.tenantId),
          serviceIdParam
            ? eq(communicationTemplates.serviceId, serviceIdParam)
            : isNull(communicationTemplates.serviceId),
          eq(communicationTemplates.templateType, type),
          eq(communicationTemplates.channel, "email")
        )
      )
      .returning({ id: communicationTemplates.id });

    if (deleted.length > 0) {
      audit({
        tenantId: admin.tenantId,
        action: serviceIdParam ? "comm_template.service_restore" : "comm_template.restore_default",
        actorUserId: admin.id,
        actorLabel: admin.email,
        entityType: "communication_template",
        entityId: deleted[0].id,
        metadata: { templateType: type, serviceId: serviceIdParam },
        ipAddress: ipFromHeaders(req.headers),
      });
    }

    return NextResponse.json({ ok: true, deleted: deleted.length });
  } catch (err) {
    return errorResponse(err);
  }
}

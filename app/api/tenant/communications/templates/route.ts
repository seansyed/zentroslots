import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { communicationTemplates } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { TEMPLATE_TYPES, templateStarterFor, type TemplateType } from "@/lib/communications/templates";
import { audit, ipFromHeaders } from "@/lib/audit";

// GET  /api/tenant/communications/templates
//   Returns one entry per supported template type. Each entry is either
//   the tenant's saved row (if any) or the system-default starter.
//
// PUT  /api/tenant/communications/templates
//   Upserts a tenant-wide template (serviceId IS NULL). Body is the
//   editor's full state for one type — we deliberately keep the API
//   tight + one-type-at-a-time so an admin's accidental clobber never
//   wipes more than one template.
//
// Service-level overrides are NOT exposed via this endpoint yet — the
// schema supports them but the admin UI is tenant-level only in this
// release. Adding service-level CRUD is a focused follow-up.

const upsertSchema = z.object({
  templateType: z.enum(TEMPLATE_TYPES as unknown as [string, ...string[]]),
  subject: z.string().max(500).nullable(),
  htmlContent: z.string().max(50_000).nullable(),
  textContent: z.string().max(20_000).nullable(),
  enabled: z.boolean(),
});

export async function GET() {
  try {
    const admin = await requireRole(["admin", "manager"]);

    const rows = await db
      .select()
      .from(communicationTemplates)
      .where(
        and(
          eq(communicationTemplates.tenantId, admin.tenantId),
          isNull(communicationTemplates.serviceId)
        )
      );

    const byType = new Map(rows.map((r) => [r.templateType, r]));

    return NextResponse.json(
      TEMPLATE_TYPES.map((type) => {
        const row = byType.get(type);
        if (row) {
          return {
            templateType: type,
            isCustomized: true,
            subject: row.subject ?? "",
            htmlContent: row.htmlContent ?? "",
            textContent: row.textContent ?? "",
            enabled: row.enabled,
            updatedAt: row.updatedAt,
          };
        }
        const starter = templateStarterFor(type);
        return {
          templateType: type,
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

    const existing = await db.query.communicationTemplates.findFirst({
      where: and(
        eq(communicationTemplates.tenantId, admin.tenantId),
        isNull(communicationTemplates.serviceId),
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
          serviceId: null,
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
      action: "comm_template.update",
      actorUserId: admin.id,
      actorLabel: admin.email,
      entityType: "communication_template",
      entityId: row.id,
      metadata: { templateType, enabled: row.enabled },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({ ok: true, id: row.id });
  } catch (err) {
    return errorResponse(err);
  }
}

// DELETE /api/tenant/communications/templates?type=X
//   Restore defaults — drops the tenant-wide override row for that
//   type. Subsequent sends will fall through to the system default.
export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const type = req.nextUrl.searchParams.get("type");
    if (!type || !(TEMPLATE_TYPES as readonly string[]).includes(type)) {
      throw new HttpError(400, "Unknown template type");
    }
    const deleted = await db
      .delete(communicationTemplates)
      .where(
        and(
          eq(communicationTemplates.tenantId, admin.tenantId),
          isNull(communicationTemplates.serviceId),
          eq(communicationTemplates.templateType, type),
          eq(communicationTemplates.channel, "email")
        )
      )
      .returning({ id: communicationTemplates.id });

    if (deleted.length > 0) {
      audit({
        tenantId: admin.tenantId,
        action: "comm_template.restore_default",
        actorUserId: admin.id,
        actorLabel: admin.email,
        entityType: "communication_template",
        entityId: deleted[0].id,
        metadata: { templateType: type },
        ipAddress: ipFromHeaders(req.headers),
      });
    }

    return NextResponse.json({ ok: true, deleted: deleted.length });
  } catch (err) {
    return errorResponse(err);
  }
}

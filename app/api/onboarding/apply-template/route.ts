import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { departments, intakeForms, services, tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { getTemplate } from "@/lib/templates";

const bodySchema = z.object({ templateId: z.string().min(1) });

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireRole(["admin"]);
    const { templateId } = bodySchema.parse(await req.json());
    const t = getTemplate(templateId);
    if (!t) throw new HttpError(404, "Template not found");

    // 1. Update tenant accent color
    await db
      .update(tenants)
      .set({ primaryColor: t.primaryColor, updatedAt: new Date() })
      .where(eq(tenants.id, admin.tenantId));

    // 2. Create intake form first (so we can attach to services)
    let intakeFormId: string | null = null;
    if (t.intakeForm) {
      const [form] = await db
        .insert(intakeForms)
        .values({
          tenantId: admin.tenantId,
          name: t.intakeForm.name,
          fields: t.intakeForm.fields,
          isActive: true,
        })
        .returning();
      intakeFormId = form.id;
    }

    // 3. Departments (skip duplicates by name)
    let deptInserted = 0;
    if (t.departments) {
      for (const d of t.departments) {
        await db
          .insert(departments)
          .values({
            tenantId: admin.tenantId,
            name: d.name,
            color: d.color ?? null,
          })
          .onConflictDoNothing();
        deptInserted++;
      }
    }

    // 4. Services
    const created: string[] = [];
    for (const svc of t.services) {
      const baseSlug = slugify(svc.name);
      // ensure slug uniqueness within tenant
      let slug = baseSlug;
      let i = 2;
      // simple uniqueness loop — cheap for small template service lists
      while (
        (await db.query.services.findFirst({
          where: and(eq(services.tenantId, admin.tenantId), eq(services.slug, slug)),
        }))
      ) {
        slug = `${baseSlug}-${i++}`;
        if (i > 50) break;
      }
      const [row] = await db
        .insert(services)
        .values({
          tenantId: admin.tenantId,
          name: svc.name,
          slug,
          description: svc.description ?? null,
          durationMinutes: svc.durationMinutes,
          price: svc.priceCents ?? 0,
          bufferBefore: svc.bufferBeforeMin ?? 0,
          bufferAfter: svc.bufferAfterMin ?? 0,
          color: svc.color ?? null,
          minNoticeMinutes: svc.minNoticeMinutes ?? null,
          maxAdvanceDays: svc.maxAdvanceDays ?? null,
          intakeFormId: intakeFormId,
        })
        .returning();
      created.push(row.id);
    }

    return NextResponse.json({
      ok: true,
      template: t.id,
      servicesCreated: created.length,
      departmentsCreated: deptInserted,
      intakeFormCreated: Boolean(intakeFormId),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

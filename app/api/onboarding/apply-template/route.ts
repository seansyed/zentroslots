import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { departments, intakeForms, services, serviceStaff, tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { getTemplate } from "@/lib/templates";
import { recordOnboardingEvent } from "@/lib/onboarding/telemetry";
import { readProgress, ONBOARDING_EVENTS } from "@/lib/onboarding/types";

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

    // ── Idempotency guard ─────────────────────────────────────────
    // If this template has already been applied, return the cached
    // result without doing any writes. Prevents duplicate-service
    // creation on refresh or double-click.
    const existing = await db.query.tenants.findFirst({
      where: eq(tenants.id, admin.tenantId),
      columns: { onboardingProgress: true },
    });
    const prevProgress = readProgress(existing?.onboardingProgress);
    if (prevProgress.templateApplied === templateId) {
      // Telemetry: we observed a repeated apply but did not create dupes.
      void recordOnboardingEvent({
        tenantId: admin.tenantId,
        actorUserId: admin.id,
        action: ONBOARDING_EVENTS.templateRepeated,
        metadata: { templateId },
      });
      return NextResponse.json({
        ok: true,
        template: t.id,
        servicesCreated: 0,
        departmentsCreated: 0,
        intakeFormCreated: false,
        idempotent: true,
      });
    }

    // ── Transactional apply ───────────────────────────────────────
    // All template inserts + the tenant color update + the progress
    // marker happen in one transaction so a mid-flight failure leaves
    // the tenant in its pre-apply state. Idempotency lives on the
    // `templateApplied` field — committing the txn is what locks it in.
    // We must merge progress INSIDE the txn so the idempotency marker
    // and the data it locks ship atomically. A two-step (txn + outside
    // update) would create a race window where a crash between commit
    // and the marker write produces duplicates on retry.
    const result = await db.transaction(async (tx) => {
      const nowIso = new Date().toISOString();

      // 1. Tenant accent color + onboarding progress (atomic w/ inserts)
      const mergedProgress = {
        ...prevProgress,
        templateApplied: templateId,
        currentStep: "hours" as const,
        steps: {
          ...(prevProgress.steps ?? {}),
          industry: { status: "complete" as const, at: nowIso, data: { templateId } },
          // A template implies the manual `service` step is bypassed.
          service: { status: "skipped" as const, at: nowIso },
        },
      };
      await tx
        .update(tenants)
        .set({
          primaryColor: t.primaryColor,
          onboardingProgress: mergedProgress,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, admin.tenantId));
      // Started_at is monotonic — set it only if NULL. Done as a
      // separate WHERE-bounded write so a re-apply doesn't overwrite
      // the original timestamp.
      await tx.execute(
        sql`UPDATE tenants
              SET onboarding_started_at = NOW()
            WHERE id = ${admin.tenantId}
              AND onboarding_started_at IS NULL`,
      );

      // 2. Intake form (so we can attach to services)
      let intakeFormId: string | null = null;
      if (t.intakeForm) {
        const [form] = await tx
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

      // 3. Departments (skip duplicates by name within tenant)
      let deptInserted = 0;
      if (t.departments) {
        for (const d of t.departments) {
          const result = await tx
            .insert(departments)
            .values({
              tenantId: admin.tenantId,
              name: d.name,
              color: d.color ?? null,
            })
            .onConflictDoNothing()
            .returning({ id: departments.id });
          if (result.length > 0) deptInserted++;
        }
      }

      // 4. Services — slug uniqueness loop scoped to this tenant
      const created: string[] = [];
      for (const svc of t.services) {
        const baseSlug = slugify(svc.name);
        let slug = baseSlug;
        let i = 2;
        while (
          (await tx.query.services.findFirst({
            where: and(eq(services.tenantId, admin.tenantId), eq(services.slug, slug)),
          }))
        ) {
          slug = `${baseSlug}-${i++}`;
          if (i > 50) break;
        }
        const [row] = await tx
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

        // Link the onboarding admin as staff for every template service.
        // Without this, the service has zero staff and the public booking
        // page silently hides it (every booking surface inner-joins
        // serviceStaff) — leaving the tenant "live" but unbookable.
        await tx.insert(serviceStaff).values({
          serviceId: row.id,
          userId: admin.id,
          tenantId: admin.tenantId,
        });
      }

      return {
        servicesCreated: created.length,
        departmentsCreated: deptInserted,
        intakeFormCreated: Boolean(intakeFormId),
      };
    });

    // Progress state, primary color, and template-applied marker were
    // all committed atomically inside the transaction above. We only
    // need to emit telemetry here — `audit()` is fire-and-forget so a
    // failure here can never affect the tenant's data.
    void recordOnboardingEvent({
      tenantId: admin.tenantId,
      actorUserId: admin.id,
      action: ONBOARDING_EVENTS.templateApplied,
      metadata: { templateId, ...result },
    });

    return NextResponse.json({
      ok: true,
      template: t.id,
      ...result,
      idempotent: false,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

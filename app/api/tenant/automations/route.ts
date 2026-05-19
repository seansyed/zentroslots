import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import {
  followupAutomationRules,
  reviewRequestRules,
  services,
} from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { errorResponse, HttpError } from "@/lib/auth";
import { requirePermissionOrRole } from "@/lib/security/permissions";
import {
  FOLLOWUP_TRIGGER_EVENTS,
  REVIEW_PLATFORMS,
} from "@/lib/automations/types";

// GET /api/tenant/automations
//
// Returns both rule sets for the caller's tenant + the service list
// to power the scope picker. Tenant-isolated.
export async function GET() {
  try {
    const admin = await requirePermissionOrRole({
      allowRoles: ["admin", "manager"],
      requirePermission: "canManageAutomation",
      auditPath: "/api/tenant/automations",
    });

    const [reviews, followups, allServices] = await Promise.all([
      db
        .select()
        .from(reviewRequestRules)
        .where(eq(reviewRequestRules.tenantId, admin.tenantId))
        .orderBy(asc(reviewRequestRules.createdAt)),
      db
        .select()
        .from(followupAutomationRules)
        .where(eq(followupAutomationRules.tenantId, admin.tenantId))
        .orderBy(asc(followupAutomationRules.createdAt)),
      db
        .select({ id: services.id, name: services.name, slug: services.slug })
        .from(services)
        .where(and(eq(services.tenantId, admin.tenantId), eq(services.isActive, 1)))
        .orderBy(asc(services.name)),
    ]);

    return NextResponse.json({
      reviews: {
        tenantDefault: reviews.find((r) => r.serviceId === null) ?? null,
        serviceRules: reviews.filter((r) => r.serviceId !== null),
      },
      followups: {
        // Multiple followups can match a tenant default (one per
        // trigger event). Return all and let the client group.
        all: followups,
      },
      services: allServices,
      reviewPlatforms: REVIEW_PLATFORMS,
      triggerEvents: FOLLOWUP_TRIGGER_EVENTS,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── Review-request upsert ─────────────────────────────────────────────

const reviewUpsertSchema = z.object({
  kind: z.literal("review"),
  serviceId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().default(true),
  delayMinutes: z.number().int().nonnegative(),
  reviewPlatform: z.enum(REVIEW_PLATFORMS as unknown as [string, ...string[]]),
  reviewUrl: z.string().url().nullable(),
  suppressIfCancelled: z.boolean(),
  suppressIfNoShow: z.boolean(),
});

const followupUpsertSchema = z.object({
  kind: z.literal("followup"),
  id: z.string().uuid().nullable().optional(),
  serviceId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().default(true),
  triggerEvent: z.enum(FOLLOWUP_TRIGGER_EVENTS as unknown as [string, ...string[]]),
  delayMinutes: z.number().int().nonnegative(),
  templateId: z.string().uuid().nullable().optional(),
  onlyFirstTimeCustomers: z.boolean(),
  onlyCompletedBookings: z.boolean(),
  requireSuccessfulPayment: z.boolean(),
});

const putSchema = z.discriminatedUnion("kind", [reviewUpsertSchema, followupUpsertSchema]);

export async function PUT(req: NextRequest) {
  try {
    const admin = await requirePermissionOrRole({
      allowRoles: ["admin", "manager"],
      requirePermission: "canManageAutomation",
      auditPath: "/api/tenant/automations",
    });
    const body = putSchema.parse(await req.json());

    // Validate any referenced serviceId belongs to this tenant.
    if (body.serviceId) {
      const svc = await db.query.services.findFirst({
        where: and(eq(services.id, body.serviceId), eq(services.tenantId, admin.tenantId)),
      });
      if (!svc) throw new HttpError(404, "Service not found in workspace");
    }

    if (body.kind === "review") {
      const existing = await db.query.reviewRequestRules.findFirst({
        where: and(
          eq(reviewRequestRules.tenantId, admin.tenantId),
          body.serviceId
            ? eq(reviewRequestRules.serviceId, body.serviceId)
            : isNull(reviewRequestRules.serviceId)
        ),
      });
      const values = {
        enabled: body.enabled,
        delayMinutes: body.delayMinutes,
        reviewPlatform: body.reviewPlatform,
        reviewUrl: body.reviewUrl,
        suppressIfCancelled: body.suppressIfCancelled,
        suppressIfNoShow: body.suppressIfNoShow,
        updatedAt: new Date(),
      };
      let id: string;
      if (existing) {
        await db.update(reviewRequestRules).set(values).where(eq(reviewRequestRules.id, existing.id));
        id = existing.id;
      } else {
        const [row] = await db
          .insert(reviewRequestRules)
          .values({
            tenantId: admin.tenantId,
            serviceId: body.serviceId ?? null,
            ...values,
          })
          .returning({ id: reviewRequestRules.id });
        id = row.id;
      }
      audit({
        tenantId: admin.tenantId,
        action: body.serviceId ? "review_request.service_update" : "review_request.tenant_default_update",
        actorUserId: admin.id,
        actorLabel: admin.email,
        entityType: "review_request_rule",
        entityId: id,
        metadata: { serviceId: body.serviceId ?? null, platform: body.reviewPlatform, delayMinutes: body.delayMinutes },
        ipAddress: ipFromHeaders(req.headers),
      });
      return NextResponse.json({ ok: true, id });
    }

    // ── follow-up upsert ─────────────────────────────────────────────
    const existing = body.id
      ? await db.query.followupAutomationRules.findFirst({
          where: and(
            eq(followupAutomationRules.id, body.id),
            eq(followupAutomationRules.tenantId, admin.tenantId)
          ),
        })
      : await db.query.followupAutomationRules.findFirst({
          where: and(
            eq(followupAutomationRules.tenantId, admin.tenantId),
            eq(followupAutomationRules.triggerEvent, body.triggerEvent),
            body.serviceId
              ? eq(followupAutomationRules.serviceId, body.serviceId)
              : isNull(followupAutomationRules.serviceId)
          ),
        });

    const values = {
      enabled: body.enabled,
      delayMinutes: body.delayMinutes,
      templateId: body.templateId ?? null,
      onlyFirstTimeCustomers: body.onlyFirstTimeCustomers,
      onlyCompletedBookings: body.onlyCompletedBookings,
      requireSuccessfulPayment: body.requireSuccessfulPayment,
      updatedAt: new Date(),
    };
    let id: string;
    if (existing) {
      await db.update(followupAutomationRules).set(values).where(eq(followupAutomationRules.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await db
        .insert(followupAutomationRules)
        .values({
          tenantId: admin.tenantId,
          serviceId: body.serviceId ?? null,
          triggerEvent: body.triggerEvent,
          ...values,
        })
        .returning({ id: followupAutomationRules.id });
      id = row.id;
    }
    audit({
      tenantId: admin.tenantId,
      action: body.serviceId ? "followup.service_update" : "followup.tenant_default_update",
      actorUserId: admin.id,
      actorLabel: admin.email,
      entityType: "followup_automation_rule",
      entityId: id,
      metadata: { serviceId: body.serviceId ?? null, triggerEvent: body.triggerEvent, delayMinutes: body.delayMinutes },
      ipAddress: ipFromHeaders(req.headers),
    });
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return errorResponse(err);
  }
}

// DELETE /api/tenant/automations?kind=review&id=...
//   |    /api/tenant/automations?kind=followup&id=...
export async function DELETE(req: NextRequest) {
  try {
    const admin = await requirePermissionOrRole({
      allowRoles: ["admin", "manager"],
      requirePermission: "canManageAutomation",
      auditPath: "/api/tenant/automations",
    });
    const kind = req.nextUrl.searchParams.get("kind");
    const id = req.nextUrl.searchParams.get("id");
    if (!id || (kind !== "review" && kind !== "followup")) {
      throw new HttpError(400, "Missing or invalid id/kind");
    }

    if (kind === "review") {
      const existing = await db.query.reviewRequestRules.findFirst({
        where: and(
          eq(reviewRequestRules.id, id),
          eq(reviewRequestRules.tenantId, admin.tenantId)
        ),
      });
      if (!existing) throw new HttpError(404, "Rule not found");
      await db.delete(reviewRequestRules).where(eq(reviewRequestRules.id, id));
      audit({
        tenantId: admin.tenantId,
        action: "review_request.delete",
        actorUserId: admin.id,
        actorLabel: admin.email,
        entityType: "review_request_rule",
        entityId: id,
        metadata: { serviceId: existing.serviceId },
        ipAddress: ipFromHeaders(req.headers),
      });
    } else {
      const existing = await db.query.followupAutomationRules.findFirst({
        where: and(
          eq(followupAutomationRules.id, id),
          eq(followupAutomationRules.tenantId, admin.tenantId)
        ),
      });
      if (!existing) throw new HttpError(404, "Rule not found");
      await db.delete(followupAutomationRules).where(eq(followupAutomationRules.id, id));
      audit({
        tenantId: admin.tenantId,
        action: "followup.delete",
        actorUserId: admin.id,
        actorLabel: admin.email,
        entityType: "followup_automation_rule",
        entityId: id,
        metadata: { serviceId: existing.serviceId, triggerEvent: existing.triggerEvent },
        ipAddress: ipFromHeaders(req.headers),
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

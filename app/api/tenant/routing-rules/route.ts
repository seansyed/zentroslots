import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import {
  services,
  staffAssignmentRules,
  tenants,
  users,
} from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { assertCanWriteRoutingRule } from "@/lib/billing/capabilities";
import { getPlan } from "@/lib/plans";
import { ROUTING_MODES, type RoutingMode } from "@/lib/routing/types";

// GET /api/tenant/routing-rules
//
// Returns the caller-tenant's routing config:
//   - tenant default rule (or null)
//   - per-service rules
//   - eligible staff per service (to power priority + weighted UIs)
//
// Tenant isolation: every query is filtered by admin.tenantId.
export async function GET() {
  try {
    const admin = await requireRole(["admin", "manager"]);

    const [rules, allServices, allStaff] = await Promise.all([
      db
        .select()
        .from(staffAssignmentRules)
        .where(eq(staffAssignmentRules.tenantId, admin.tenantId))
        .orderBy(asc(staffAssignmentRules.createdAt)),
      db
        .select({ id: services.id, name: services.name, slug: services.slug })
        .from(services)
        .where(and(eq(services.tenantId, admin.tenantId), eq(services.isActive, 1)))
        .orderBy(asc(services.name)),
      db
        .select({ id: users.id, name: users.name, email: users.email, role: users.role })
        .from(users)
        .where(eq(users.tenantId, admin.tenantId))
        .orderBy(asc(users.name)),
    ]);

    return NextResponse.json({
      tenantDefault: rules.find((r) => r.serviceId === null && r.locationId === null) ?? null,
      serviceRules: rules.filter((r) => r.serviceId !== null),
      services: allServices,
      staff: allStaff.filter((s) => s.role !== "client"),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── PUT: upsert a routing rule (tenant default OR per-service) ────────

const putSchema = z.object({
  serviceId: z.string().uuid().nullable().optional(),
  mode: z.enum(ROUTING_MODES as unknown as [string, ...string[]]),
  enabled: z.boolean().default(true),
  priorityOrder: z.array(z.string().uuid()).default([]),
  weightedDistribution: z.record(z.string(), z.number().min(0).max(100)).default({}),
});

export async function PUT(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const body = putSchema.parse(await req.json());
    const serviceId = body.serviceId ?? null;

    // ── Plan gate (Phase 16K hardening) ──────────────────────────
    // Staff routing rules are Pro+. Existing rules continue to run
    // via the engine — this blocks NEW writes only.
    const tenantRow = await db.query.tenants.findFirst({
      where: eq(tenants.id, admin.tenantId),
      columns: { currentPlan: true },
    });
    const plan = getPlan(tenantRow?.currentPlan);
    try {
      assertCanWriteRoutingRule(plan);
    } catch (err) {
      audit({
        tenantId: admin.tenantId,
        action: "billing.enforcement_denied",
        actorUserId: admin.id,
        actorLabel: admin.email,
        entityType: "billing",
        metadata: { capability: "routing_rules", plan: plan.id, mode: body.mode, serviceId },
        ipAddress: ipFromHeaders(req.headers),
      });
      throw err;
    }

    // If serviceId set, validate it belongs to this tenant. Cross-tenant
    // service ids return 404.
    if (serviceId) {
      const svc = await db.query.services.findFirst({
        where: and(eq(services.id, serviceId), eq(services.tenantId, admin.tenantId)),
      });
      if (!svc) throw new HttpError(404, "Service not found in workspace");
    }

    // Validate every referenced staff id belongs to this tenant —
    // applies to priorityOrder + weightedDistribution keys. Catches
    // copy-paste mistakes AND prevents cross-tenant id injection.
    const referencedStaff = new Set<string>([
      ...body.priorityOrder,
      ...Object.keys(body.weightedDistribution),
    ]);
    if (referencedStaff.size > 0) {
      const referencedArr = Array.from(referencedStaff);
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.tenantId, admin.tenantId),
            inArray(users.id, referencedArr)
          )
        );
      const valid = new Set(rows.map((r) => r.id));
      for (const id of referencedStaff) {
        if (!valid.has(id)) {
          throw new HttpError(400, "Unknown staff id in routing config");
        }
      }
    }

    const existing = await db.query.staffAssignmentRules.findFirst({
      where: and(
        eq(staffAssignmentRules.tenantId, admin.tenantId),
        serviceId
          ? eq(staffAssignmentRules.serviceId, serviceId)
          : isNull(staffAssignmentRules.serviceId),
        isNull(staffAssignmentRules.locationId)
      ),
    });

    let id: string;
    if (existing) {
      await db
        .update(staffAssignmentRules)
        .set({
          mode: body.mode,
          enabled: body.enabled,
          priorityOrder: body.priorityOrder,
          weightedDistribution: body.weightedDistribution,
          updatedAt: new Date(),
        })
        .where(eq(staffAssignmentRules.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await db
        .insert(staffAssignmentRules)
        .values({
          tenantId: admin.tenantId,
          serviceId,
          locationId: null,
          mode: body.mode as RoutingMode,
          enabled: body.enabled,
          priorityOrder: body.priorityOrder,
          weightedDistribution: body.weightedDistribution,
        })
        .returning({ id: staffAssignmentRules.id });
      id = row.id;
    }

    audit({
      tenantId: admin.tenantId,
      action: serviceId ? "routing.service_update" : "routing.tenant_default_update",
      actorUserId: admin.id,
      actorLabel: admin.email,
      entityType: "staff_assignment_rule",
      entityId: id,
      metadata: { serviceId, mode: body.mode, enabled: body.enabled },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── DELETE: remove a routing rule (revert to "no rule" / legacy behavior) ─

export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const id = req.nextUrl.searchParams.get("id");
    if (!id) throw new HttpError(400, "Missing id");

    const existing = await db.query.staffAssignmentRules.findFirst({
      where: and(
        eq(staffAssignmentRules.id, id),
        eq(staffAssignmentRules.tenantId, admin.tenantId)
      ),
    });
    if (!existing) throw new HttpError(404, "Rule not found");

    await db.delete(staffAssignmentRules).where(eq(staffAssignmentRules.id, id));

    audit({
      tenantId: admin.tenantId,
      action: "routing.delete",
      actorUserId: admin.id,
      actorLabel: admin.email,
      entityType: "staff_assignment_rule",
      entityId: id,
      metadata: { serviceId: existing.serviceId, mode: existing.mode },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

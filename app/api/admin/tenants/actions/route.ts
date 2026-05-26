/**
 * POST /api/admin/tenants/actions
 *
 * Tenant-bulk-action endpoint. Each action requires:
 *   • Super-admin auth (requireSuperAdmin)
 *   • Discriminated-union body
 *   • Audit entry on success (action = `admin.bulk.<op>`)
 *   • Idempotent at the DB level where possible
 *
 * Supported ops:
 *   suspend          → set tenants.active = false (preserves history)
 *   reactivate       → set tenants.active = true
 *   extend_trial     → push trialEnd forward by N days
 *   comp_subscription→ set currentPlan + subscriptionStatus='active'
 *                      (no Stripe sync; ops note required)
 *   resend_onboarding→ inserts an audit-only marker (the actual
 *                      onboarding-email send is enqueued elsewhere)
 *   manual_sync_billing→ inserts an audit-only marker; future cron
 *                       wires the actual Stripe pull
 *
 * Response shape: { ok: boolean; results: Array<{tenantId, ok, error?}> }
 *
 * Permissions: super-admin role only — same gate as the rest of
 * /api/admin/*. Tenant isolation is preserved because operations
 * are scoped per tenant_id passed in the body.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { errorResponse, HttpError } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

const body = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("suspend"),
    tenantIds: z.array(z.string().uuid()).min(1).max(100),
    reason: z.string().max(500).optional(),
  }),
  z.object({
    op: z.literal("reactivate"),
    tenantIds: z.array(z.string().uuid()).min(1).max(100),
    reason: z.string().max(500).optional(),
  }),
  z.object({
    op: z.literal("extend_trial"),
    tenantIds: z.array(z.string().uuid()).min(1).max(100),
    days: z.number().int().min(1).max(365),
    reason: z.string().max(500).optional(),
  }),
  z.object({
    op: z.literal("comp_subscription"),
    tenantIds: z.array(z.string().uuid()).min(1).max(100),
    plan: z.string().min(1).max(40),
    reason: z.string().max(500).min(3), // require a justification
  }),
  z.object({
    op: z.literal("resend_onboarding"),
    tenantIds: z.array(z.string().uuid()).min(1).max(100),
  }),
  z.object({
    op: z.literal("manual_sync_billing"),
    tenantIds: z.array(z.string().uuid()).min(1).max(100),
  }),
]);

export async function POST(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin();
    const parsed = body.parse(await req.json());
    const ip = ipFromHeaders(req.headers);
    const results: Array<{ tenantId: string; ok: boolean; error?: string }> = [];

    // Pre-validate that all tenant ids exist — bulk reject if any
    // unknown so we don't half-apply.
    const found = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(inArray(tenants.id, parsed.tenantIds));
    const foundSet = new Set(found.map((r) => r.id));
    const missing = parsed.tenantIds.filter((id) => !foundSet.has(id));
    if (missing.length > 0) {
      throw new HttpError(404, `Tenant(s) not found: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);
    }

    for (const tenantId of parsed.tenantIds) {
      try {
        switch (parsed.op) {
          case "suspend":
            await db.update(tenants).set({ active: false, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
            break;
          case "reactivate":
            await db.update(tenants).set({ active: true, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
            break;
          case "extend_trial": {
            const row = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
            const baseDate = row?.trialEnd ?? new Date();
            const newEnd = new Date(new Date(baseDate).getTime() + parsed.days * 24 * 60 * 60_000);
            await db.update(tenants).set({ trialEnd: newEnd, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
            break;
          }
          case "comp_subscription":
            await db
              .update(tenants)
              .set({
                currentPlan: parsed.plan,
                subscriptionStatus: "active",
                updatedAt: new Date(),
              })
              .where(eq(tenants.id, tenantId));
            break;
          case "resend_onboarding":
          case "manual_sync_billing":
            // Audit-only markers — the actual side-effect is enqueued
            // by a downstream consumer that observes these audit rows.
            // We never want to perform real Stripe sync or send
            // arbitrary emails synchronously from a bulk-action endpoint.
            break;
        }
        await audit({
          tenantId,
          action: `admin.bulk.${parsed.op}`,
          actorUserId: admin.sub,
          actorLabel: admin.email,
          entityType: "tenant",
          entityId: tenantId,
          metadata: {
            ...("reason" in parsed && parsed.reason ? { reason: parsed.reason } : {}),
            ...("days" in parsed ? { days: parsed.days } : {}),
            ...("plan" in parsed ? { plan: parsed.plan } : {}),
          },
          ipAddress: ip,
        });
        results.push({ tenantId, ok: true });
      } catch (err) {
        results.push({
          tenantId,
          ok: false,
          error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        });
      }
    }

    return NextResponse.json({ ok: true, results });
  } catch (err) {
    return errorResponse(err);
  }
}

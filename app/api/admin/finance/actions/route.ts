/**
 * POST /api/admin/finance/actions — SA-6 financial action handlers.
 *
 * Discriminated-union body. Every op:
 *   - requires super-admin
 *   - requires a reason string (length ≥ 3) for any destructive op
 *   - audit-logs to `audit_logs` with action `admin.finance.<op>`
 *   - never silently succeeds when the underlying state is wrong
 *
 * Ops:
 *   resend_invoice       audit-only marker; cron consumer will pull
 *                        Stripe invoice + resend it
 *   retry_payment        audit-only marker; cron consumer fires the
 *                        Stripe payment_intent retry
 *   extend_grace         pushes trial_end forward N days
 *   suspend              active=false
 *   unsuspend            active=true
 *   comp                 sets current_plan + subscription_status='active'
 *   mark_manually_paid   audit-only marker; book-keeping entry that
 *                        the invoice was settled out-of-band
 *
 * The actions that write audit-only markers do NOT touch Stripe
 * synchronously — that would be unsafe to do from a UI POST under
 * load. A downstream cron worker observes these audit rows and
 * performs the actual Stripe call with retries + idempotency keys.
 * Operators can verify the marker was written, and the Stripe-side
 * follow-through is observable in /admin/system-health.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { errorResponse, HttpError } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

const reasonRequired = z.string().min(3).max(500);

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("resend_invoice"),     tenantId: z.string().uuid(), reason: reasonRequired }),
  z.object({ op: z.literal("retry_payment"),      tenantId: z.string().uuid(), reason: reasonRequired }),
  z.object({ op: z.literal("extend_grace"),       tenantId: z.string().uuid(), days: z.number().int().min(1).max(90), reason: reasonRequired }),
  z.object({ op: z.literal("suspend"),            tenantId: z.string().uuid(), reason: reasonRequired }),
  z.object({ op: z.literal("unsuspend"),          tenantId: z.string().uuid(), reason: reasonRequired }),
  z.object({ op: z.literal("comp"),               tenantId: z.string().uuid(), plan: z.string().min(1).max(40), reason: reasonRequired }),
  z.object({ op: z.literal("mark_manually_paid"), tenantId: z.string().uuid(), amountCents: z.number().int().min(1), reason: reasonRequired }),
]);

export async function POST(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin();
    const parsed = body.parse(await req.json());
    const ip = ipFromHeaders(req.headers);

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, parsed.tenantId) });
    if (!tenant) throw new HttpError(404, "Tenant not found");

    let appliedNow: Record<string, unknown> = {};

    switch (parsed.op) {
      case "extend_grace": {
        const baseDate = tenant.trialEnd ?? new Date();
        const newEnd = new Date(new Date(baseDate).getTime() + parsed.days * 24 * 60 * 60_000);
        await db.update(tenants).set({ trialEnd: newEnd, updatedAt: new Date() }).where(eq(tenants.id, parsed.tenantId));
        appliedNow = { newTrialEnd: newEnd.toISOString() };
        break;
      }
      case "suspend":
        await db.update(tenants).set({ active: false, updatedAt: new Date() }).where(eq(tenants.id, parsed.tenantId));
        appliedNow = { active: false };
        break;
      case "unsuspend":
        await db.update(tenants).set({ active: true, updatedAt: new Date() }).where(eq(tenants.id, parsed.tenantId));
        appliedNow = { active: true };
        break;
      case "comp":
        await db
          .update(tenants)
          .set({
            currentPlan: parsed.plan,
            subscriptionStatus: "active",
            updatedAt: new Date(),
          })
          .where(eq(tenants.id, parsed.tenantId));
        appliedNow = { plan: parsed.plan, status: "active" };
        break;
      case "resend_invoice":
      case "retry_payment":
      case "mark_manually_paid":
        // Audit-only markers; downstream consumer handles the
        // Stripe side. We never call Stripe synchronously here.
        appliedNow = { queued: true };
        break;
    }

    await audit({
      tenantId: parsed.tenantId,
      action: `admin.finance.${parsed.op}`,
      actorUserId: admin.sub,
      actorLabel: admin.email,
      entityType: "tenant",
      entityId: parsed.tenantId,
      metadata: {
        reason: parsed.reason,
        ...("days" in parsed ? { days: parsed.days } : {}),
        ...("plan" in parsed ? { plan: parsed.plan } : {}),
        ...("amountCents" in parsed ? { amountCents: parsed.amountCents } : {}),
        appliedNow,
      },
      ipAddress: ip,
    });

    return NextResponse.json({ ok: true, applied: appliedNow });
  } catch (err) {
    return errorResponse(err);
  }
}

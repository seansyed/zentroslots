/**
 * Wave H — Payment routing activation endpoint.
 *
 *   GET  /api/tenant/payment-routing
 *     Returns the activation snapshot: current flag, kill-switch state,
 *     resolved routing mode, prerequisite checklist, canActivate.
 *
 *   POST /api/tenant/payment-routing
 *     Body: { enabled: boolean }
 *     enabled=true  → server re-evaluates prereqs; 409 if blocked.
 *     enabled=false → always allowed (instant rollback).
 *
 * Admin-only. Rate-limited per (tenant, user) so a frantic admin can't
 * accidentally storm the audit log. The endpoint is the ONLY supported
 * surface for flipping `tenants.use_tenant_payment_providers` — direct
 * DB writes are out of scope and unaudited.
 *
 * Safety invariants preserved (NONE of which this endpoint changes):
 *   • PHASE3_KILL_SWITCH is evaluated by the booking resolver on every
 *     request — disabling the kill switch here is impossible (it's an
 *     env var). When the kill switch is active, canActivate is false.
 *   • Strict no-fallback: the booking resolver still 503s when the flag
 *     is on but no usable default exists. The activation gate makes
 *     that state difficult to *enter* but doesn't change its handling.
 *   • Legacy platform path stays byte-identical when the flag is false.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { audit, ipFromHeaders } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import {
  evaluateActivation,
  summarizeChecklistForAudit,
} from "@/lib/payments/activation";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  enabled: z.boolean(),
});

// ─── GET ──────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const user = await requireRole(["admin"]);
    const snap = await evaluateActivation(user.tenantId);
    return NextResponse.json(snap);
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── POST ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const user = await requireRole(["admin"]);
    const ip = ipFromHeaders(req.headers) ?? "anon";

    // Per-tenant rate limit. Generous enough for a few clicks during
    // a setup session, tight enough to block accidental loops.
    const rl = rateLimit({
      key: `payment-routing:${user.tenantId}`,
      capacity: 10,
      refillTokens: 10,
      windowMs: 60_000,
    });
    if (!rl.ok) {
      throw new HttpError(429, "Too many activation attempts — try again shortly");
    }

    const body = bodySchema.parse(await req.json());

    // Read current state + snapshot for both branches. We always
    // evaluate prereqs even on disable, so the audit metadata captures
    // a complete picture of the world at the moment of the flip.
    const before = await evaluateActivation(user.tenantId);

    if (body.enabled) {
      // ── Enable path: gated by prereqs + kill-switch ────────────────
      if (!before.canActivate) {
        // Audit the BLOCKED attempt so operators can see when admins
        // tried to enable before setup was complete (signals bad UX or
        // an admin who needs help).
        await audit({
          tenantId: user.tenantId,
          actorUserId: user.id,
          action: "payment_routing.activation.blocked",
          entityType: "tenant",
          entityId: user.tenantId,
          metadata: {
            reason: before.blockedReason,
            killSwitchActive: before.killSwitchActive,
            checklist: summarizeChecklistForAudit(before),
          },
          ipAddress: ip === "anon" ? null : ip,
        });
        // 409 — semantically "preconditions not met". The client uses
        // the body to refresh the checklist and show what failed.
        return NextResponse.json(
          {
            error: "preconditions_failed",
            blockedReason: before.blockedReason,
            snapshot: before,
          },
          { status: 409 },
        );
      }

      // No-op if already enabled — return the snapshot without writing
      // OR auditing. Saves noise on UI refresh races.
      if (before.enabled) {
        return NextResponse.json(before);
      }

      await db
        .update(tenants)
        .set({ useTenantPaymentProviders: true })
        .where(eq(tenants.id, user.tenantId));

      const after = await evaluateActivation(user.tenantId);

      await audit({
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: "payment_routing.activation.enabled",
        entityType: "tenant",
        entityId: user.tenantId,
        metadata: {
          previousMode: before.routingMode,
          newMode: after.routingMode,
          checklist: summarizeChecklistForAudit(after),
        },
        ipAddress: ip === "anon" ? null : ip,
      });

      return NextResponse.json(after);
    }

    // ── Disable path: ALWAYS allowed ────────────────────────────────
    // Admins must always be able to flip back to the legacy platform
    // path. Disabling is the rollback lever — it doesn't have prereqs
    // and never refuses. We do enforce no-op short-circuit so a double-
    // tap doesn't audit twice.
    if (!before.enabled) {
      return NextResponse.json(before);
    }

    await db
      .update(tenants)
      .set({ useTenantPaymentProviders: false })
      .where(eq(tenants.id, user.tenantId));

    const after = await evaluateActivation(user.tenantId);

    await audit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "payment_routing.activation.disabled",
      entityType: "tenant",
      entityId: user.tenantId,
      metadata: {
        previousMode: before.routingMode,
        newMode: after.routingMode,
      },
      ipAddress: ip === "anon" ? null : ip,
    });

    return NextResponse.json(after);
  } catch (err) {
    return errorResponse(err);
  }
}

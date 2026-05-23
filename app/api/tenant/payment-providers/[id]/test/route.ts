/**
 * Wave H Phase 5 — Test Connection.
 *
 *   POST /api/tenant/payment-providers/<id>/test
 *
 * Runs the adapter's validateCredentials, persists the outcome
 * (capabilities + status + last_verified_at OR last_error). Rate-limited
 * so a worried admin clicking the button can't accidentally trigger a
 * burst against the provider.
 */

import { NextRequest, NextResponse } from "next/server";

import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { ipFromHeaders, audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import {
  getProviderRedacted,
  testConnection,
} from "@/lib/payments/connections";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["admin"]);
    const { id } = await context.params;
    if (!id || !UUID_RE.test(id)) throw new HttpError(404, "Not found");

    const ip = ipFromHeaders(req.headers) ?? "anon";
    const rl = rateLimit({
      // Per-provider rate limit so a tenant with two providers
      // doesn't have one blocked by activity on the other.
      key: `payment-test:${user.tenantId}:${id}`,
      capacity: 10,
      refillTokens: 10,
      windowMs: 60_000,
    });
    if (!rl.ok) {
      throw new HttpError(429, "Too many test runs — try again shortly");
    }

    const result = await testConnection(user.tenantId, id);
    const row = await getProviderRedacted(user.tenantId, id);
    if (!row) throw new HttpError(404, "Not found");

    audit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "payment_provider.test_connection",
      entityType: "tenant_payment_provider",
      entityId: id,
      metadata: {
        ok: result.ok,
        errorClass: result.ok ? undefined : result.errorClass,
      },
      ipAddress: ip === "anon" ? null : ip,
    });

    return NextResponse.json({
      provider: row,
      validation: result.ok
        ? { ok: true, capabilities: result.capabilities }
        : { ok: false, errorClass: result.errorClass, message: result.message },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

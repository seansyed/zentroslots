/**
 * Wave H Phase 5 — Set as default for its mode.
 *
 *   POST /api/tenant/payment-providers/<id>/default
 *
 * Atomic transactional setDefault. The partial unique index
 *   tenant_payment_providers_default ON (tenant_id, mode) WHERE is_default
 * is the source of truth — setDefault clears the prior default then
 * sets the new one in a single transaction.
 */

import { NextRequest, NextResponse } from "next/server";

import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { ipFromHeaders, audit } from "@/lib/audit";
import {
  getProviderRedacted,
  setDefault,
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

    // Read the row first so we know its mode (setDefault needs it for
    // the WHERE clause).
    const existing = await getProviderRedacted(user.tenantId, id);
    if (!existing) throw new HttpError(404, "Not found");
    if (!existing.enabled) {
      throw new HttpError(
        409,
        "Provider is disabled — re-enable it before setting as default",
      );
    }

    const row = await setDefault(user.tenantId, id, existing.mode);
    if (!row) throw new HttpError(404, "Not found");

    audit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "payment_provider.set_default",
      entityType: "tenant_payment_provider",
      entityId: id,
      metadata: { mode: existing.mode, provider: existing.provider },
      ipAddress: ipFromHeaders(req.headers),
    });
    return NextResponse.json({ provider: row });
  } catch (err) {
    return errorResponse(err);
  }
}

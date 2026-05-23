/**
 * Wave H Phase 5 — single provider read / patch / delete.
 *
 *   GET    /api/tenant/payment-providers/<id>
 *   PATCH  /api/tenant/payment-providers/<id>   { accountLabel?, enabled? }
 *   DELETE /api/tenant/payment-providers/<id>
 *
 * Admin-only, tenant-scoped via the row's tenantId match.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { ipFromHeaders, audit } from "@/lib/audit";
import {
  deleteProvider,
  getProviderRedacted,
  setEnabled,
} from "@/lib/payments/connections";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateId(id: string | undefined): string {
  if (!id || !UUID_RE.test(id)) throw new HttpError(404, "Not found");
  return id;
}

// ─── GET ────────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["admin"]);
    const { id } = await context.params;
    const validId = validateId(id);
    const row = await getProviderRedacted(user.tenantId, validId);
    if (!row) throw new HttpError(404, "Not found");
    return NextResponse.json({ provider: row });
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── PATCH ──────────────────────────────────────────────────────────────

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    accountLabel: z.string().trim().max(120).optional(),
  })
  .refine((v) => v.enabled !== undefined || v.accountLabel !== undefined, {
    message: "Nothing to update",
  });

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["admin"]);
    const { id } = await context.params;
    const validId = validateId(id);
    const body = patchSchema.parse(await req.json());

    // For Phase 5 we ship just the enabled toggle and label rename.
    // Other mutations (set default, rotate secret, set webhook secret)
    // have their own dedicated endpoints for clear audit + intent.
    let row = null;
    if (body.enabled !== undefined) {
      row = await setEnabled(user.tenantId, validId, body.enabled);
      if (!row) throw new HttpError(404, "Not found");
    }
    // accountLabel rename is intentionally NOT wired in Phase 5 — the
    // existing setEnabled doesn't touch the label, and a rename helper
    // would need its own audit. Skipped for now; label is set at
    // upsert time. (Documented gap for Phase 5.1.)
    if (body.accountLabel !== undefined && body.enabled === undefined) {
      throw new HttpError(
        501,
        "Label rename not implemented in Phase 5 — re-create the provider to change the label",
      );
    }

    audit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "payment_provider.patch",
      entityType: "tenant_payment_provider",
      entityId: validId,
      metadata: { enabled: body.enabled },
      ipAddress: ipFromHeaders(req.headers),
    });
    return NextResponse.json({ provider: row });
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── DELETE ─────────────────────────────────────────────────────────────

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["admin"]);
    const { id } = await context.params;
    const validId = validateId(id);
    const ok = await deleteProvider(user.tenantId, validId);
    if (!ok) throw new HttpError(404, "Not found");
    audit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "payment_provider.delete",
      entityType: "tenant_payment_provider",
      entityId: validId,
      ipAddress: ipFromHeaders(req.headers),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

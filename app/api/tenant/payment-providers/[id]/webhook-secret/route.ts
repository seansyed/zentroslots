/**
 * Wave H Phase 5 — patch webhook signing secret.
 *
 *   POST /api/tenant/payment-providers/<id>/webhook-secret  { secret }
 *
 * Second-step flow: tenant configures their webhook in the provider's
 * dashboard, receives the signing secret (whsec_… for Stripe, webhook id
 * for PayPal), pastes it here. Encrypted at write time, flips
 * webhook_status to 'configured', clears prior webhook errors.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { ipFromHeaders, audit } from "@/lib/audit";
import { setWebhookSecret } from "@/lib/payments/connections";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const schema = z.object({
  secret: z
    .string()
    .trim()
    .min(10, "Webhook secret looks too short")
    .max(2000, "Webhook secret is unexpectedly long"),
});

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["admin"]);
    const { id } = await context.params;
    if (!id || !UUID_RE.test(id)) throw new HttpError(404, "Not found");
    const body = schema.parse(await req.json());

    const row = await setWebhookSecret(user.tenantId, id, body.secret);
    if (!row) throw new HttpError(404, "Not found");

    audit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "payment_provider.webhook_secret_set",
      entityType: "tenant_payment_provider",
      entityId: id,
      // Never log the secret itself or its preview — just that it was set.
      metadata: { provider: row.provider, mode: row.mode },
      ipAddress: ipFromHeaders(req.headers),
    });
    return NextResponse.json({ provider: row });
  } catch (err) {
    return errorResponse(err);
  }
}

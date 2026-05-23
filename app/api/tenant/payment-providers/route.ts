/**
 * Wave H Phase 5 — Settings → Payments API.
 *
 *   GET  /api/tenant/payment-providers       — list all (redacted)
 *   POST /api/tenant/payment-providers       — create / upsert
 *
 * Admin-only. Every response returns the redacted shape — secrets never
 * cross this boundary. Test Connection runs automatically after upsert
 * so the row's status reflects validation reality immediately.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { ipFromHeaders, audit } from "@/lib/audit";
import {
  listProvidersForTenant,
  testConnection,
  upsertProvider,
} from "@/lib/payments/connections";
import { SUPPORTED_PROVIDERS } from "@/lib/payments/registry";

export const dynamic = "force-dynamic";

// ─── GET ────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const user = await requireRole(["admin"]);
    const rows = await listProvidersForTenant(user.tenantId);
    return NextResponse.json({ providers: rows });
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── POST ───────────────────────────────────────────────────────────────

const upsertSchema = z.object({
  provider: z.enum(SUPPORTED_PROVIDERS as [string, ...string[]]),
  mode: z.enum(["live", "test"]),
  accountLabel: z.string().trim().max(120).default(""),
  secret: z
    .string()
    .trim()
    .min(10, "Secret looks too short")
    .max(2000, "Secret is unexpectedly long"),
  publishableKey: z.string().trim().max(2000).nullish(),
  clientId: z.string().trim().max(2000).nullish(),
  // Webhook secret is optional at create time — typical flow is
  // tenant configures the webhook in the provider dashboard AFTER
  // saving the main credentials, then patches it via the dedicated
  // webhook-secret endpoint.
  webhookSecret: z.string().trim().min(10).max(2000).nullish(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requireRole(["admin"]);
    // Tight rate limit — adding a provider runs a Test Connection
    // (network call to Stripe/PayPal), which we don't want hammered.
    const ip = ipFromHeaders(req.headers) ?? "anon";
    const rl = rateLimit({
      key: `payment-providers-upsert:${user.tenantId}:${ip}`,
      capacity: 10,
      refillTokens: 10,
      windowMs: 60_000,
    });
    if (!rl.ok) {
      throw new HttpError(429, "Too many requests — try again shortly");
    }
    const body = upsertSchema.parse(await req.json());

    const row = await upsertProvider({
      tenantId: user.tenantId,
      provider: body.provider as "stripe" | "paypal",
      mode: body.mode,
      accountLabel: body.accountLabel,
      secret: body.secret,
      publishableKey: body.publishableKey ?? null,
      clientId: body.clientId ?? null,
      webhookSecret: body.webhookSecret ?? null,
      createdByUserId: user.id,
    });

    // Auto-run Test Connection right after upsert so the row's status
    // is 'verified' / 'invalid' on the very next render. Caller doesn't
    // have to make a second round-trip.
    const validate = await testConnection(user.tenantId, row.id);

    audit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "payment_provider.upsert",
      entityType: "tenant_payment_provider",
      entityId: row.id,
      metadata: {
        provider: row.provider,
        mode: row.mode,
        validateOk: validate.ok,
        validateErrorClass: validate.ok ? undefined : validate.errorClass,
      },
      ipAddress: ip === "anon" ? null : ip,
    });

    // Re-list so the response carries the post-test status. Cheap; one
    // tenant, indexed read.
    const after = await listProvidersForTenant(user.tenantId);
    const updated = after.find((r) => r.id === row.id) ?? row;

    return NextResponse.json({
      provider: updated,
      validation: validate.ok
        ? { ok: true, capabilities: validate.capabilities }
        : { ok: false, errorClass: validate.errorClass, message: validate.message },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

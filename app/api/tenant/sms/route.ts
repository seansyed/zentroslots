import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenantSmsProviders } from "@/db/schema";
import { errorResponse, requireRole, HttpError } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { audit, ipFromHeaders } from "@/lib/audit";
import { looksLikePhoneNumber } from "@/lib/sms";

// Provider config is configured by admin only — manager-level cannot see
// or rotate credentials. Auth tokens are write-only over the wire; reads
// return a redacted summary so the secret never round-trips back.

const upsertSchema = z.object({
  provider: z.enum(["twilio", "telnyx"]),
  accountId: z.string().max(120).nullable().optional(),
  // When omitted on PUT, we keep the existing encrypted value untouched.
  authToken: z.string().min(8).max(500).optional(),
  senderId: z.string().min(2).max(40).refine(
    (s) => /^[A-Za-z0-9+]+$/.test(s),
    "Sender must be E.164 (e.g. +15551234567), short code, or alphanumeric."
  ),
  webhookSecret: z.string().max(500).nullable().optional(),
  active: z.boolean().optional(),
});

// GET — return the redacted config for the calling admin's tenant, or
// null when nothing is configured.
export async function GET() {
  try {
    const admin = await requireRole(["admin"]);
    const row = await db.query.tenantSmsProviders.findFirst({
      where: eq(tenantSmsProviders.tenantId, admin.tenantId),
    });
    if (!row) return NextResponse.json(null);
    return NextResponse.json({
      id: row.id,
      provider: row.provider,
      accountId: row.accountId,
      senderId: row.senderId,
      // Hard rule: never echo the encrypted envelope or its contents to
      // any client. We just confirm a token is on file.
      authTokenSet: Boolean(row.authTokenEncrypted),
      webhookSecretSet: Boolean(row.webhookSecretEncrypted),
      active: row.active,
      totalSent: row.totalSent,
      totalFailed: row.totalFailed,
      lastSendAt: row.lastSendAt,
      lastError: row.lastError,
      lastErrorAt: row.lastErrorAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// PUT — upsert provider config. On the first call authToken is required;
// on subsequent updates it can be omitted to keep the existing token.
export async function PUT(req: NextRequest) {
  try {
    const admin = await requireRole(["admin"]);
    const body = upsertSchema.parse(await req.json());

    if (body.provider === "twilio" && !body.accountId) {
      throw new HttpError(400, "Twilio requires an Account SID.");
    }
    if (!looksLikePhoneNumber(body.senderId) && body.senderId.length < 4) {
      throw new HttpError(400, "Sender must be a phone number, short code, or alphanumeric ID.");
    }

    const existing = await db.query.tenantSmsProviders.findFirst({
      where: eq(tenantSmsProviders.tenantId, admin.tenantId),
    });

    if (!existing && !body.authToken) {
      throw new HttpError(400, "Auth token is required when first connecting a provider.");
    }

    const patch: Record<string, unknown> = {
      tenantId: admin.tenantId,
      provider: body.provider,
      accountId: body.accountId ?? null,
      senderId: body.senderId,
      active: body.active ?? true,
      updatedAt: new Date(),
    };
    if (body.authToken) patch.authTokenEncrypted = encryptSecret(body.authToken)!;
    if (body.webhookSecret !== undefined) {
      patch.webhookSecretEncrypted = body.webhookSecret ? encryptSecret(body.webhookSecret) : null;
    }

    let row;
    if (existing) {
      [row] = await db
        .update(tenantSmsProviders)
        .set(patch)
        .where(eq(tenantSmsProviders.tenantId, admin.tenantId))
        .returning();
    } else {
      [row] = await db
        .insert(tenantSmsProviders)
        .values(patch as typeof tenantSmsProviders.$inferInsert)
        .returning();
    }

    audit({
      tenantId: admin.tenantId,
      action: existing ? "sms_provider.updated" : "sms_provider.connected",
      actorUserId: admin.id,
      actorLabel: admin.email,
      entityType: "sms_provider",
      entityId: row.id,
      metadata: {
        provider: body.provider,
        senderId: body.senderId,
        rotatedToken: Boolean(body.authToken),
      },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({
      id: row.id,
      provider: row.provider,
      accountId: row.accountId,
      senderId: row.senderId,
      authTokenSet: true,
      active: row.active,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// DELETE — remove provider entirely. Tenant will fall back to no-SMS
// behavior (sendSms returns { ok: false, reason: 'no_provider' }).
export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireRole(["admin"]);
    const existing = await db.query.tenantSmsProviders.findFirst({
      where: eq(tenantSmsProviders.tenantId, admin.tenantId),
    });
    if (!existing) return NextResponse.json({ ok: true, alreadyEmpty: true });
    await db.delete(tenantSmsProviders).where(eq(tenantSmsProviders.tenantId, admin.tenantId));
    audit({
      tenantId: admin.tenantId,
      action: "sms_provider.disconnected",
      actorUserId: admin.id,
      actorLabel: admin.email,
      entityType: "sms_provider",
      entityId: existing.id,
      metadata: { provider: existing.provider },
      ipAddress: ipFromHeaders(req.headers),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

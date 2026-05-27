/**
 * /api/mobile/push-tokens — Expo push-token registration for the
 * native app.
 *
 *   POST   { token, deviceLabel?, platform? }  → upsert
 *   DELETE { token? }                           → unregister
 *
 * Persistence landed in Phase 1C (2026-05-27). Phase 1B logged only;
 * the worker scripts/run-push-deliveries.ts now consumes
 * push_tokens + push_deliveries to deliver booking events.
 *
 * Idempotency: INSERT … ON CONFLICT (user_id, expo_token) DO UPDATE —
 * re-registration on every cold start is safe and updates
 * device_label / platform / updated_at.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { pushTokens } from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const registerSchema = z.object({
  token: z
    .string()
    .min(20)
    .max(200)
    .refine(
      (t) =>
        t.startsWith("ExponentPushToken[") ||
        t.startsWith("ExpoPushToken[") ||
        /^[A-Za-z0-9_-]{20,}$/.test(t),
      "Invalid Expo push token format",
    ),
  deviceLabel: z.string().max(120).optional(),
  platform: z.enum(["ios", "android", "web"]).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = registerSchema.parse(await req.json());

    await db
      .insert(pushTokens)
      .values({
        userId: user.id,
        tenantId: user.tenantId,
        expoToken: body.token,
        platform: body.platform ?? null,
        deviceLabel: body.deviceLabel ?? null,
      })
      .onConflictDoUpdate({
        target: [pushTokens.userId, pushTokens.expoToken],
        set: {
          platform: body.platform ?? null,
          deviceLabel: body.deviceLabel ?? null,
          updatedAt: new Date(),
        },
      });

    return NextResponse.json({ ok: true, persisted: true });
  } catch (err) {
    return errorResponse(err);
  }
}

const deleteSchema = z.object({
  /** Optional — if provided, clears only that one device. If absent,
   *  clears every device the caller currently has registered. */
  token: z.string().min(20).max(200).optional(),
});

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireUser();
    let body: { token?: string } = {};
    try {
      const text = await req.text();
      if (text.trim().length > 0) {
        body = deleteSchema.parse(JSON.parse(text));
      }
    } catch {
      body = {};
    }

    if (body.token) {
      await db
        .delete(pushTokens)
        .where(
          and(eq(pushTokens.userId, user.id), eq(pushTokens.expoToken, body.token)),
        );
    } else {
      await db.delete(pushTokens).where(eq(pushTokens.userId, user.id));
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

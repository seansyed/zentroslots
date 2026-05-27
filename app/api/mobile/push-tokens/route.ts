/**
 * /api/mobile/push-tokens
 *
 * Expo push-token registration surface for the native app.
 *
 *   POST   { token: "ExponentPushToken[...]", deviceLabel?: string, platform?: "ios"|"android" }
 *   DELETE — clears the caller's token (sign-out / disable)
 *
 * Phase 1B foundation (2026-05-27):
 * Persistence is intentionally deferred to Phase 1C. Real push
 * delivery requires three pieces — (1) token storage, (2) a sender
 * worker that fans out on booking lifecycle events, (3) topic
 * subscription preferences. This route is the foundation: it
 * accepts + validates the token contract so the mobile app can
 * register safely against production, and it logs every registration
 * to stderr so operators can see device adoption before the storage
 * layer lands.
 *
 * When 1C ships, swap the `console.error` lines for inserts into
 * push_tokens (or users.expo_push_token, depending on schema).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const registerSchema = z.object({
  token: z
    .string()
    .min(20)
    .max(200)
    .refine(
      (t) => t.startsWith("ExponentPushToken[") || t.startsWith("ExpoPushToken[") || /^[A-Za-z0-9_-]{20,}$/.test(t),
      "Invalid Expo push token format",
    ),
  deviceLabel: z.string().max(120).optional(),
  platform: z.enum(["ios", "android", "web"]).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = registerSchema.parse(await req.json());

    // Phase 1B stub — log for visibility, return ok. Persistence in 1C.
    console.error(
      JSON.stringify({
        evt: "push_token_register",
        userId: user.id,
        tenantId: user.tenantId,
        platform: body.platform ?? null,
        deviceLabel: body.deviceLabel ?? null,
        tokenSuffix: body.token.slice(-10),
        ts: new Date().toISOString(),
      }),
    );

    return NextResponse.json({ ok: true, persisted: false });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE() {
  try {
    const user = await requireUser();
    console.error(
      JSON.stringify({
        evt: "push_token_unregister",
        userId: user.id,
        tenantId: user.tenantId,
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

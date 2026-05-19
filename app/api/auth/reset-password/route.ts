/**
 * POST /api/auth/reset-password
 *
 * Body: { token, newPassword }
 *
 * Consumes a password-reset token (one-time use) and sets the user's
 * new password. On success ALSO bumps users.sessionMinIat which
 * invalidates every existing session for that user — defence-in-depth
 * against the case where an attacker had stolen a session cookie.
 *
 * Public response is generic regardless of token validity to avoid
 * leaking token state.
 *
 * Rate-limited per IP (5 attempts / hour).
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { ipFromHeaders } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { hashPassword, revokeAllSessionsForUser } from "@/lib/auth";
import { consumePasswordResetToken } from "@/lib/security/passwordReset";
import { recordSessionEvent } from "@/lib/security/sessionEvents";
import { recordSecurityAudit } from "@/lib/security/audit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  token: z.string().min(1).max(200),
  newPassword: z
    .string()
    .min(10, "Password must be at least 10 characters.")
    .max(200),
});

export async function POST(req: NextRequest) {
  const ip = ipFromHeaders(req.headers) ?? "anon";
  const userAgent = req.headers.get("user-agent")?.slice(0, 1000) ?? null;

  const rl = rateLimit({
    key: `reset-password:${ip}`,
    capacity: 5,
    refillTokens: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch (err) {
    // For password length failures, surface the specific message so
    // the UI can show "min 10 chars". Token failures get the generic
    // path below.
    const issues =
      err && typeof err === "object" && "issues" in err
        ? (err as { issues: Array<{ message: string; path: (string | number)[] }> }).issues
        : [];
    const pwIssue = issues.find((i) => i.path[0] === "newPassword");
    if (pwIssue) {
      return NextResponse.json({ ok: false, error: pwIssue.message }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const result = await consumePasswordResetToken({
    rawToken: parsed.token,
    consumedIp: ip === "anon" ? null : ip,
    consumedUserAgent: userAgent,
  });

  if (!result.ok) {
    // Generic public message — does not differentiate not_found vs
    // expired vs already_consumed to avoid timing/state leaks.
    return NextResponse.json(
      { ok: false, error: "invalid_or_expired" },
      { status: 400 }
    );
  }

  // Hash + update. On infra failure we collapse to the same generic
  // invalid_or_expired response — never leak that the DB is sideways
  // (an attacker probing for "is reset wired up at all?" gets nothing).
  const passwordHash = await hashPassword(parsed.newPassword);
  try {
    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, result.userId));
  } catch (err) {
    console.error("[auth] reset-password update failed:", err);
    return NextResponse.json({ ok: false, error: "invalid_or_expired" }, { status: 400 });
  }

  // Bulk-revoke any active sessions — anyone who had stolen a cookie
  // is forced to re-auth.
  await revokeAllSessionsForUser(result.userId);

  // Load the user for audit labels.
  const user = await db.query.users.findFirst({ where: eq(users.id, result.userId) });

  await recordSessionEvent({
    tenantId: result.tenantId,
    userId: result.userId,
    eventType: "password_reset_completed",
    ipAddress: ip === "anon" ? null : ip,
    userAgent,
    metadata: { tokenId: result.tokenId },
  });

  await recordSecurityAudit({
    tenantId: result.tenantId,
    category: "security.password_reset.completed",
    actorUserId: result.userId,
    actorLabel: user?.name,
    entityType: "user",
    entityId: result.userId,
    ipAddress: ip === "anon" ? null : ip,
  });

  return NextResponse.json({ ok: true });
}

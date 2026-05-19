import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import {
  createTokenWithJti,
  errorResponse,
  HttpError,
  setSessionCookie,
  verifyPassword,
} from "@/lib/auth";
import { loginSchema } from "@/lib/validation";
import { rateLimit } from "@/lib/rate-limit";
import { audit, ipFromHeaders } from "@/lib/audit";
import { recordSessionEvent, userAgentFromHeaders } from "@/lib/security/sessionEvents";
import { deviceLabelFor, evaluateLoginSuspicion } from "@/lib/security/heuristics";
import { recordSecurityAudit } from "@/lib/security/audit";

export async function POST(req: NextRequest) {
  const ip = ipFromHeaders(req.headers) ?? "anon";
  const userAgent = userAgentFromHeaders(req.headers);
  try {
    // 10 login attempts per minute per IP. Slows password spraying.
    const rl = rateLimit({ key: `login:${ip}`, capacity: 10, refillTokens: 10, windowMs: 60_000 });
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many attempts — try again shortly." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }

    const body = loginSchema.parse(await req.json());

    // Email is unique per tenant, not globally. If a tenantSlug was sent,
    // scope the lookup. Otherwise we accept the first match — fine for MVP
    // since admins typically know their workspace and we'll add a
    // per-workspace login form before that's ambiguous in practice.
    const user = await db.query.users.findFirst({
      where: eq(users.email, body.email),
    });
    if (!user) {
      // Record the failed attempt against the tenant we COULD NOT
      // identify by recording without a user_id. Best-effort: no-op
      // if we never even saw an email.
      // NOTE: session_audit_events.tenant_id is NOT NULL, so we can
      // only persist this when we know which tenant the attempt
      // targeted. Without a tenantSlug + no matching email, log to
      // stdout only.
      console.log(
        JSON.stringify({
          evt: "auth.login_failed.unknown_user",
          ip,
          email_domain: body.email.split("@")[1] ?? "?",
          ts: new Date().toISOString(),
        })
      );
      throw new HttpError(401, "Invalid credentials");
    }

    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) {
      // Record the failed attempt — we know the tenant now.
      await recordSessionEvent({
        tenantId: user.tenantId,
        userId: user.id,
        eventType: "login_failed",
        ipAddress: ip === "anon" ? null : ip,
        userAgent,
        deviceLabel: deviceLabelFor(userAgent),
        metadata: { reason: "bad_password" },
      });
      await recordSecurityAudit({
        tenantId: user.tenantId,
        category: "security.access.failed_login",
        actorUserId: user.id,
        actorLabel: user.name,
        ipAddress: ip === "anon" ? null : ip,
        metadata: { reason: "bad_password" },
      });
      throw new HttpError(401, "Invalid credentials");
    }

    const { token, jti } = await createTokenWithJti({
      sub: user.id,
      role: user.role,
      email: user.email,
      tenantId: user.tenantId,
    });
    await setSessionCookie(token);

    // Run suspicious-login heuristic against the user's last-known
    // login fingerprint. NEVER blocks login — purely advisory.
    const suspicion = evaluateLoginSuspicion({
      currentIp: ip === "anon" ? null : ip,
      currentUserAgent: userAgent,
      priorIp: user.lastLoginIp,
      priorUserAgent: user.lastLoginUserAgent,
      priorLoginAt: user.lastLoginAt,
    });

    // Update last-login fingerprint AFTER the heuristic runs so the
    // current attempt isn't compared against itself.
    try {
      await db
        .update(users)
        .set({
          lastLoginAt: new Date(),
          lastLoginIp: ip === "anon" ? null : ip,
          lastLoginUserAgent: userAgent,
        })
        .where(eq(users.id, user.id));
    } catch (e) {
      console.error("[auth] last-login bookkeeping failed:", e);
    }

    // Persist the login event.
    await recordSessionEvent({
      tenantId: user.tenantId,
      userId: user.id,
      eventType: "login",
      sessionJti: jti,
      ipAddress: ip === "anon" ? null : ip,
      userAgent,
      deviceLabel: deviceLabelFor(userAgent),
      metadata: { signals: suspicion.signals },
    });

    // If the heuristic flagged it, also persist an explicit
    // suspicious_login event so the dashboard can filter it
    // separately + alert pipelines can react.
    if (suspicion.suspicious) {
      await recordSessionEvent({
        tenantId: user.tenantId,
        userId: user.id,
        eventType: "suspicious_login",
        sessionJti: jti,
        ipAddress: ip === "anon" ? null : ip,
        userAgent,
        deviceLabel: deviceLabelFor(userAgent),
        metadata: { signals: suspicion.signals, summary: suspicion.summary },
      });
      await recordSecurityAudit({
        tenantId: user.tenantId,
        category: "security.session.suspicious_login",
        actorUserId: user.id,
        actorLabel: user.name,
        ipAddress: ip === "anon" ? null : ip,
        metadata: { signals: suspicion.signals, summary: suspicion.summary },
      });
    }

    // Preserve the legacy audit.login row so existing tooling that
    // greps for action='auth.login' still works.
    audit({
      tenantId: user.tenantId,
      action: "auth.login",
      actorUserId: user.id,
      actorLabel: user.name,
      ipAddress: ip === "anon" ? null : ip,
    });

    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      timezone: user.timezone,
      tenantId: user.tenantId,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

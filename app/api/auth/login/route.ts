import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import {
  createToken,
  errorResponse,
  HttpError,
  setSessionCookie,
  verifyPassword,
} from "@/lib/auth";
import { loginSchema } from "@/lib/validation";
import { rateLimit } from "@/lib/rate-limit";
import { audit, ipFromHeaders } from "@/lib/audit";

export async function POST(req: NextRequest) {
  try {
    // 10 login attempts per minute per IP. Slows password spraying.
    const ip = ipFromHeaders(req.headers) ?? "anon";
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
    if (!user) throw new HttpError(401, "Invalid credentials");

    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) throw new HttpError(401, "Invalid credentials");

    const token = await createToken({
      sub: user.id,
      role: user.role,
      email: user.email,
      tenantId: user.tenantId,
    });
    await setSessionCookie(token);

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

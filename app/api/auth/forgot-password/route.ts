/**
 * POST /api/auth/forgot-password
 *
 * Generates a password-reset token + emails it to the user. ALWAYS
 * returns 200 OK with the same shape regardless of whether the email
 * exists — prevents email enumeration.
 *
 * Rate-limited:
 *   - per IP: 10 requests / hour
 *   - per email: 3 requests / hour (best-effort — bot can rotate emails
 *     but per-IP cap is the real wall)
 *
 * Tenant-scoped: email is unique per tenant, not globally. If the
 * caller knows their workspace slug, send it in the body for a precise
 * lookup. Without slug we use the FIRST match (same fallback the login
 * route uses).
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { ipFromHeaders } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { generatePasswordResetToken } from "@/lib/security/passwordReset";
import { recordSessionEvent } from "@/lib/security/sessionEvents";
import { recordSecurityAudit } from "@/lib/security/audit";
import { sendEmail } from "@/lib/email";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  /** Optional workspace slug for tenant-scoped lookup. */
  tenantSlug: z.string().trim().min(1).max(80).optional(),
});

export async function POST(req: NextRequest) {
  const ip = ipFromHeaders(req.headers) ?? "anon";

  // Per-IP rate limit.
  const rl = rateLimit({
    key: `forgot-password:${ip}`,
    capacity: 10,
    refillTokens: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { ok: true }, // still generic
      { status: 200 }
    );
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    // Generic success even on bad input — no enumeration via 400.
    return NextResponse.json({ ok: true });
  }

  // Per-email best-effort rate limit (additional layer).
  const emailKey = `forgot-password-email:${parsed.email}`;
  const emailRl = rateLimit({
    key: emailKey,
    capacity: 3,
    refillTokens: 3,
    windowMs: 60 * 60 * 1000,
  });
  if (!emailRl.ok) {
    return NextResponse.json({ ok: true });
  }

  // Resolve the user — tenant-scoped if a slug was provided. Any DB
  // failure is treated as "no match" so the response stays generic
  // (zero-leak: an attacker can't distinguish "user doesn't exist"
  // from "DB unreachable" by timing or response shape).
  let user: typeof users.$inferSelect | undefined;
  try {
    if (parsed.tenantSlug) {
      const tenant = await db.query.tenants.findFirst({
        where: eq(tenants.slug, parsed.tenantSlug),
      });
      if (tenant) {
        user = await db.query.users.findFirst({
          where: and(eq(users.tenantId, tenant.id), eq(users.email, parsed.email)),
        });
      }
    } else {
      user = await db.query.users.findFirst({ where: eq(users.email, parsed.email) });
    }
  } catch (err) {
    console.error("[auth] forgot-password user lookup failed:", err);
    user = undefined;
  }

  // Always succeed publicly. If no user, audit the unmatched attempt
  // (no PII to the response body) and return.
  if (!user) {
    console.log(
      JSON.stringify({
        evt: "auth.forgot_password.unmatched",
        ip,
        email_domain: parsed.email.split("@")[1] ?? "?",
        ts: new Date().toISOString(),
      })
    );
    return NextResponse.json({ ok: true });
  }

  // Generate the token. Best-effort dispatch — never fails the request.
  try {
    const { rawToken, expiresAt } = await generatePasswordResetToken({
      tenantId: user.tenantId,
      userId: user.id,
      requestedIp: ip === "anon" ? null : ip,
    });

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
    const tenantName = tenant?.name ?? "your workspace";
    const appBase = (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
    const link = `${appBase}/reset-password/${encodeURIComponent(rawToken)}`;
    const expiresStr = expiresAt.toUTCString();

    const subject = `Reset your ${tenantName} password`;
    const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
      <h1 style="font-size:18px;margin:0 0 8px">Reset your password</h1>
      <p style="font-size:14px;color:#475569;margin:0 0 20px">
        We received a request to reset the password for your account at
        ${escapeHtml(tenantName)}. Click the link below — it expires in 1 hour
        (${escapeHtml(expiresStr)}).
      </p>
      <p style="margin:0 0 20px">
        <a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Reset password</a>
      </p>
      <p style="font-size:12px;color:#94a3b8;margin:0">
        If you didn&rsquo;t request this, you can ignore this email — no changes have been made.
      </p>
    </body></html>`;
    const text = `Reset your password for ${tenantName}: ${link}\n\nLink expires in 1 hour (${expiresStr}).\n\nIf you didn't request this, ignore this email.`;

    await sendEmail({
      to: user.email,
      subject,
      html,
      text,
      audit: { tenantId: user.tenantId, kind: "password_reset" },
    });

    await recordSessionEvent({
      tenantId: user.tenantId,
      userId: user.id,
      eventType: "password_reset_requested",
      ipAddress: ip === "anon" ? null : ip,
      userAgent: req.headers.get("user-agent")?.slice(0, 1000) ?? null,
    });

    await recordSecurityAudit({
      tenantId: user.tenantId,
      category: "security.password_reset.requested",
      actorUserId: user.id,
      actorLabel: user.name,
      entityType: "user",
      entityId: user.id,
      ipAddress: ip === "anon" ? null : ip,
    });
  } catch (err) {
    // Log and continue — public response stays generic.
    console.error("[auth] forgot-password dispatch failed:", err);
  }

  return NextResponse.json({ ok: true });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

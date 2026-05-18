import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { customers, tenants } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { signClientMagicLink } from "@/lib/client-auth";
import { rateLimit } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email";
import { audit, ipFromHeaders } from "@/lib/audit";

// POST /api/client/[slug]/auth/login
// Body: { email }
//
// Always returns 200 OK regardless of whether the email exists in the
// tenant's customer list. This prevents email-enumeration: an attacker
// can't tell whether jane@example.com has booked at this business just
// by hitting login. We send the link only when a real customer matches.

const bodySchema = z.object({
  email: z.string().email().max(255),
});

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    const ip = ipFromHeaders(req.headers) ?? "anon";

    // Rate limit by (tenant slug, IP) — generous enough for honest typo
    // retries but a hard wall against credential-stuffing-style scans.
    const rl = rateLimit({
      key: `client-login:${slug}:${ip}`,
      capacity: 10,
      refillTokens: 10,
      windowMs: 10 * 60 * 1000,
    });
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many login attempts. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
    if (!tenant || !tenant.active) {
      // Don't reveal whether the slug exists either.
      return NextResponse.json({ ok: true });
    }

    const body = bodySchema.parse(await req.json());
    const emailLower = body.email.trim().toLowerCase();

    // Look up by case-insensitive email scoped to this tenant.
    const customer = await db.query.customers.findFirst({
      where: and(
        eq(customers.tenantId, tenant.id),
        sql`lower(${customers.email}) = ${emailLower}`
      ),
    });

    if (customer) {
      const token = await signClientMagicLink({
        email: customer.email,
        tenantId: tenant.id,
      });
      const appBase = (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
      const link = `${appBase}/client/${encodeURIComponent(tenant.slug)}/auth/verify?token=${encodeURIComponent(token)}`;

      const subject = `Sign in to ${tenant.name}`;
      const html = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
          <h1 style="font-size:18px;margin:0 0 8px">Sign in to ${escapeHtml(tenant.name)}</h1>
          <p style="font-size:14px;color:#475569;margin:0 0 20px">
            Click the link below to access your bookings and account. This link expires in 15 minutes.
          </p>
          <p style="margin:0 0 20px">
            <a href="${link}" style="display:inline-block;background:${tenant.primaryColor};color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Sign in</a>
          </p>
          <p style="font-size:12px;color:#94a3b8;margin:0">
            If you didn&rsquo;t request this, you can safely ignore this email.
          </p>
        </div>`;
      const text = `Sign in to ${tenant.name}: ${link}\n\nLink expires in 15 minutes. If you didn't request this, ignore this email.`;

      // Fire-and-forget; sendEmail audits its own success/failure.
      await sendEmail({
        to: customer.email,
        subject,
        html,
        text,
        audit: { tenantId: tenant.id, kind: "client_magiclink" },
      });

      audit({
        tenantId: tenant.id,
        action: "client.magiclink.sent",
        entityType: "customer",
        entityId: customer.id,
        metadata: { email: emailLower },
        ipAddress: ipFromHeaders(req.headers),
      });
    } else {
      // Audit the unmatched attempt so admins can see if someone is
      // probing email addresses.
      audit({
        tenantId: tenant.id,
        action: "client.magiclink.unmatched",
        metadata: { email: emailLower },
        ipAddress: ipFromHeaders(req.headers),
      });
    }

    // Same response either way.
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err);
    return errorResponse(err);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}

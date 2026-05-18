import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { sendEmail } from "@/lib/email";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { ipFromHeaders } from "@/lib/audit";
import { renderVariables, type TemplateContext } from "@/lib/communications/variables";

// POST /api/tenant/communications/templates/test-send
//   Sends the draft template (rendered with sample variables) to a
//   specific recipient. Bypasses the customer-pref gate by design —
//   this is a deliberate admin action, not a customer-driven send.
//   Heavily rate-limited.

const bodySchema = z.object({
  to: z.string().email(),
  subject: z.string().max(500),
  htmlContent: z.string().max(50_000),
  textContent: z.string().max(20_000),
  context: z.record(z.string(), z.string().nullable()).default({}),
});

export async function POST(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const ip = ipFromHeaders(req.headers) ?? "anon";

    const rl = rateLimit({
      key: `template-test:${admin.tenantId}:${ip}`,
      capacity: 10,
      refillTokens: 10,
      windowMs: 10 * 60 * 1000,
    });
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many test sends. Try again in a few minutes." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }

    const body = bodySchema.parse(await req.json());
    const ctx = body.context as TemplateContext;

    const result = await sendEmail({
      to: body.to,
      subject: renderVariables(body.subject, ctx),
      html: renderVariables(body.htmlContent, ctx),
      text: renderVariables(body.textContent, ctx),
    });

    if (!result.ok) {
      throw new HttpError(502, result.reason ?? "Send failed");
    }
    return NextResponse.json({ ok: true, provider: result.provider });
  } catch (err) {
    return errorResponse(err);
  }
}

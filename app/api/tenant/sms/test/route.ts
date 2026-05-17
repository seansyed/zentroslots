import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, requireRole, HttpError } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { ipFromHeaders } from "@/lib/audit";
import { looksLikePhoneNumber, sendSms } from "@/lib/sms";

// POST /api/tenant/sms/test — fires a one-off SMS so the admin can
// confirm credentials work end-to-end. Rate-limited so an admin can't
// accidentally (or maliciously) burn through their Twilio balance.

const bodySchema = z.object({
  to: z.string().min(4).max(20),
  body: z.string().min(1).max(500).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const admin = await requireRole(["admin"]);
    const ip = ipFromHeaders(req.headers) ?? "anon";

    // 10 tests per 10 minutes per (tenant, ip). High enough for honest
    // troubleshooting, low enough to prevent abuse.
    const rl = rateLimit({
      key: `sms-test:${admin.tenantId}:${ip}`,
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

    const { to, body } = bodySchema.parse(await req.json());
    if (!looksLikePhoneNumber(to)) {
      throw new HttpError(400, "Recipient must be a phone number in E.164 format (e.g. +15551234567).");
    }

    const result = await sendSms({
      tenantId: admin.tenantId,
      to,
      body: body ?? "Hello from your scheduling workspace — this is a test message.",
      audit: { kind: "test" },
    });

    if (result.ok) {
      return NextResponse.json({
        ok: true,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
      });
    }

    // Provider failure: surface a 4xx so the UI shows the error inline.
    // 'no_provider' isn't an error per se — it means the admin hasn't
    // connected one yet.
    if (result.reason === "no_provider") {
      throw new HttpError(409, "No SMS provider is connected. Configure one above first.");
    }
    throw new HttpError(502, result.error ?? "Provider rejected the message.");
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/public/demo
 *
 * Public website demo-request endpoint. Production-critical.
 *
 * Same protection recipe as /api/public/contact:
 *   1. Per-IP rate limit (3 submissions / hour — demo requests are
 *      lower volume than general contact).
 *   2. Honeypot field `website`.
 *   3. Field validation + length caps.
 *   4. Always returns 200 OK on validation failure.
 *
 * Dispatch (via lib/notify-support):
 *   - Notifies DEMO_EMAIL (falls back to SUPPORT_EMAIL → EMAIL_FROM).
 *   - Sends branded "thanks for your interest" autoresponder.
 *
 * Never throws.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { rateLimit } from "@/lib/rate-limit";
import { ipFromHeaders } from "@/lib/audit";
import { sendDemoRequestNotification, resolveDemoInbox } from "@/lib/notify-support";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(255),
  company: z.string().trim().max(200).optional(),
  teamSize: z.string().trim().max(40).optional(),
  useCase: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(40).optional(),
  message: z.string().trim().max(2000).optional(),
  /** Honeypot field. */
  website: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const ip = ipFromHeaders(req.headers) ?? "anon";
  const userAgent = req.headers.get("user-agent")?.slice(0, 200) ?? null;

  // ── Rate limit (per-IP, 3/hour) ───────────────────────────────────
  const rl = rateLimit({
    key: `public-demo:${ip}`,
    capacity: 3,
    refillTokens: 3,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.ok) {
    logEvent("demo_rate_limited", { ip, retry_after_ms: rl.retryAfterMs });
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  // ── Parse + validate ──────────────────────────────────────────────
  let parsed: z.infer<typeof bodySchema>;
  try {
    const raw = await req.json();
    parsed = bodySchema.parse(raw);
  } catch (err) {
    logEvent("demo_validation_failed", {
      ip,
      err: err instanceof Error ? err.message.slice(0, 200) : "parse_error",
    });
    return NextResponse.json({ ok: true, received: false });
  }

  // ── Honeypot ──────────────────────────────────────────────────────
  if (parsed.website && parsed.website.trim().length > 0) {
    logEvent("demo_honeypot_triggered", { ip, ua: userAgent });
    return NextResponse.json({ ok: true });
  }

  // ── Light spam heuristic on optional message ──────────────────────
  if (parsed.message && looksLikeSpam(parsed.message)) {
    logEvent("demo_spam_heuristic", { ip, ua: userAgent });
    return NextResponse.json({ ok: true });
  }

  // ── Dispatch ──────────────────────────────────────────────────────
  const demoInbox = resolveDemoInbox();
  if (!demoInbox) {
    logEvent("demo_no_inbox_configured", { ip, name: parsed.name, email: parsed.email });
    return NextResponse.json({ ok: true, notified: false });
  }

  const result = await sendDemoRequestNotification({
    name: parsed.name,
    email: parsed.email,
    company: parsed.company,
    teamSize: parsed.teamSize,
    useCase: parsed.useCase,
    phone: parsed.phone,
    message: parsed.message,
    ipAddress: ip,
    userAgent,
  });

  logEvent("demo_submission", {
    ip,
    name: parsed.name,
    email_domain: parsed.email.split("@")[1] ?? "?",
    company: parsed.company ?? null,
    team_size: parsed.teamSize ?? null,
    notified: result.notificationDispatched,
    autoresponded: result.autoresponderDispatched,
    notify_err: result.notificationError ?? null,
    auto_err: result.autoresponderError ?? null,
    ms: Date.now() - startedAt,
  });

  return NextResponse.json({
    ok: true,
    notified: result.notificationDispatched,
    autoresponded: result.autoresponderDispatched,
  });
}

function looksLikeSpam(text: string): boolean {
  const lower = text.toLowerCase();
  const urlCount = (lower.match(/https?:\/\//g) ?? []).length;
  if (urlCount > 3) return true;
  if (/\b(viagra|cialis|crypto|bitcoin|seo|backlink|payday loan)\b/i.test(lower)) return true;
  return false;
}

function logEvent(evt: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ evt: `public_form.${evt}`, ts: new Date().toISOString(), ...fields }));
}

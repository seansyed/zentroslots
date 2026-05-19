/**
 * POST /api/public/contact
 *
 * Public website contact-form endpoint. Production-critical.
 *
 * Protections (in order):
 *   1. Per-IP rate limit (5 submissions / hour).
 *   2. Honeypot field `website` — bots fill every input; humans never
 *      see this (display:none in the form). Non-empty honeypot returns
 *      200 OK but silently drops the message.
 *   3. Field length + content sanity (email regex, message 10..5000).
 *   4. Always returns 200 OK on validation failure to avoid leaking
 *      what the server validates (defence-in-depth against probing).
 *
 * Dispatch (via lib/notify-support):
 *   - Notifies SUPPORT_EMAIL with the submission.
 *   - Sends a branded autoresponder to the submitter.
 *
 * Never throws. Email failures are logged with category and reported
 * in the response body as `notified: false` — the marketing site can
 * surface a "we'll get back to you" message either way (since the
 * submission still gets logged for ops review).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { rateLimit } from "@/lib/rate-limit";
import { ipFromHeaders } from "@/lib/audit";
import { sendContactFormNotification, resolveSupportInbox } from "@/lib/notify-support";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(255),
  company: z.string().trim().max(200).optional(),
  message: z.string().trim().min(10).max(5000),
  /** Honeypot — bots fill this. The marketing form must keep this
   *  input hidden via CSS and aria-hidden. Servers must accept the
   *  field name 'website' and silently drop submissions when it's
   *  non-empty. */
  website: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const ip = ipFromHeaders(req.headers) ?? "anon";
  const userAgent = req.headers.get("user-agent")?.slice(0, 200) ?? null;

  // ── Rate limit (per-IP, 5/hour) ───────────────────────────────────
  const rl = rateLimit({
    key: `public-contact:${ip}`,
    capacity: 5,
    refillTokens: 5,
    windowMs: 60 * 60 * 1000,
  });
  if (!rl.ok) {
    logEvent("contact_rate_limited", { ip, retry_after_ms: rl.retryAfterMs });
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
    // Return 200 OK so an attacker can't probe the schema.
    logEvent("contact_validation_failed", {
      ip,
      err: err instanceof Error ? err.message.slice(0, 200) : "parse_error",
    });
    return NextResponse.json({ ok: true, received: false });
  }

  // ── Honeypot: silently swallow ────────────────────────────────────
  if (parsed.website && parsed.website.trim().length > 0) {
    logEvent("contact_honeypot_triggered", { ip, ua: userAgent });
    return NextResponse.json({ ok: true });
  }

  // ── Light content heuristic: spam signals ─────────────────────────
  if (looksLikeSpam(parsed.message) || looksLikeSpam(parsed.name)) {
    logEvent("contact_spam_heuristic", { ip, ua: userAgent });
    return NextResponse.json({ ok: true });
  }

  // ── Dispatch ──────────────────────────────────────────────────────
  const supportInbox = resolveSupportInbox();
  if (!supportInbox) {
    // Misconfigured deploy — we still want the submission preserved
    // somewhere. Log structurally; operators can grep.
    logEvent("contact_no_inbox_configured", { ip, name: parsed.name, email: parsed.email });
    return NextResponse.json({ ok: true, notified: false, queued: false });
  }

  const result = await sendContactFormNotification({
    name: parsed.name,
    email: parsed.email,
    company: parsed.company,
    message: parsed.message,
    ipAddress: ip,
    userAgent,
  });

  logEvent("contact_submission", {
    ip,
    name: parsed.name,
    email_domain: parsed.email.split("@")[1] ?? "?",
    company: parsed.company ?? null,
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
  // Conservative heuristics — false positives are worse than false
  // negatives here (a legit message wrongly dropped is invisible to
  // ops). Only catch the obvious cases.
  const lower = text.toLowerCase();
  // Excessive URLs.
  const urlCount = (lower.match(/https?:\/\//g) ?? []).length;
  if (urlCount > 3) return true;
  // Crypto / SEO spam markers.
  if (/\b(viagra|cialis|crypto|bitcoin|seo|backlink|payday loan)\b/i.test(lower)) return true;
  return false;
}

function logEvent(evt: string, fields: Record<string, unknown>): void {
  // Single-line JSON — easy to grep / forward to a log aggregator.
  console.log(JSON.stringify({ evt: `public_form.${evt}`, ts: new Date().toISOString(), ...fields }));
}

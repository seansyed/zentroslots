/**
 * POST /api/mobile/telemetry
 *
 * Receives batched telemetry events from the ZentroMeet mobile app
 * (the in-device ring buffer at zentromeet-mobile/src/lib/telemetry.ts
 * periodically flushes to this endpoint). Events are emitted to the
 * structured logger so `pm2 logs scheduling-saas | grep mobile_telemetry`
 * surfaces them in real time.
 *
 * Design choices:
 *   • Auth-optional. Beta operators may crash *before* a session lands;
 *     we still want those events. If a session is present, we tag the
 *     userId + tenantId; otherwise we tag `anonymous`.
 *   • No new DB table. This is observability, not analytics. Durable
 *     logging belongs in the existing structured-logger sink (pino in
 *     prod, pretty-print in dev).
 *   • Strict batch cap. 100 events per request. A buggy client that
 *     spams events shouldn't be able to take this endpoint down.
 *   • PII-safe by contract. The mobile telemetry module documents that
 *     it never captures request bodies, tokens, or user-typed text —
 *     only structural metadata (URLs, status codes, error names, route
 *     segments). We accept that contract and don't enforce it here.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { errorResponse, getSession } from "@/lib/auth";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

const eventSchema = z.object({
  ts: z.number().int().positive(),
  kind: z.enum(["crash", "runtime", "network", "mutation", "navigation", "info"]),
  severity: z.enum(["info", "warn", "error"]),
  label: z.string().min(1).max(500),
  // Detail is free-form structured data — accept any JSON value but
  // strip nested objects that exceed a reasonable size at the caller.
  detail: z.unknown().optional(),
});

const batchSchema = z.object({
  // Mobile app version so we can correlate spikes with releases.
  appVersion: z.string().max(32).optional(),
  // Platform string — "ios" / "android" / "web" / "unknown".
  platform: z.string().max(32).optional(),
  // Device-stable id (NOT user id) so we can de-dupe events from the
  // same crashing device without identifying the user. Mobile generates
  // this once per install and stores it locally.
  deviceId: z.string().max(64).optional(),
  events: z.array(eventSchema).min(1).max(100),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = batchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid telemetry batch", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const { appVersion, platform, deviceId, events } = parsed.data;

    // Session is optional. We tag the events with whatever we know
    // about the caller — pre-login boot events get `anonymous`.
    const session = await getSession().catch(() => null);
    const userId = session?.sub ?? "anonymous";
    const tenantId = session?.tenantId ?? "anonymous";

    // Emit one structured log line per event so pm2 logs / Cloudwatch
    // search picks them up at the per-event grain.
    for (const ev of events) {
      const fields = {
        mobile_telemetry: true,
        ts: ev.ts,
        kind: ev.kind,
        severity: ev.severity,
        label: ev.label,
        detail: ev.detail ?? null,
        appVersion: appVersion ?? null,
        platform: platform ?? null,
        deviceId: deviceId ?? null,
        userId,
        tenantId,
      };
      if (ev.severity === "error") {
        log.error(`mobile:${ev.kind}`, undefined, fields);
      } else if (ev.severity === "warn") {
        log.warn(`mobile:${ev.kind}`, fields);
      } else {
        log.info(`mobile:${ev.kind}`, fields);
      }
    }

    return NextResponse.json({ ok: true, received: events.length });
  } catch (err) {
    return errorResponse(err);
  }
}

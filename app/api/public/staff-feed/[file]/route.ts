/**
 * Phase ICAL-2 — public staff calendar subscription endpoint.
 *
 *   GET /api/public/staff-feed/<token>.ics
 *
 * Returns a multi-event VCALENDAR (METHOD:PUBLISH) representing the
 * authenticated staff's bookings + calendar events + group sessions
 * over a bounded window.
 *
 * Path shape choice:
 *   The Next.js [file] catch-segment receives the literal value
 *   "<token>.ics". We strip the .ics suffix server-side and use the
 *   remaining string as the raw token. Apple Calendar requires the
 *   URL to end in .ics for the file-association handler to fire on
 *   tap-to-subscribe.
 *
 * Security:
 *   • Token verification IS the auth surface — no session, no
 *     cookie, no header. The token's hash is the proof.
 *   • Same generic 404 for every failure mode (bad token format,
 *     revoked token, deleted user, deleted tenant) → no token
 *     enumeration.
 *   • Rate-limited PER TOKEN (60 polls / 5 min — Apple polls hourly
 *     so this is generous) AND PER IP (200 polls / 5 min — absorbs
 *     a household sharing a NAT).
 *   • last_accessed_at + last_accessed_ip recorded best-effort so
 *     admins can see device polling pattern.
 *   • Tenant + user scoping enforced inside buildStaffFeedEvents
 *     (defense in depth).
 *
 * Caching:
 *   • ETag = sha256(body) first 16 hex. If the client sends
 *     If-None-Match matching, we return 304 with no body — Apple
 *     uses this aggressively to avoid re-parsing a 50 KB feed
 *     hourly when nothing changed.
 *   • Last-Modified honored on If-Modified-Since.
 *   • Cache-Control: private, max-age=300 — five-minute window
 *     where the same client gets a 200 even without conditional
 *     headers. PM2 multi-instance safe because each instance
 *     regenerates from DB; the ETag derivation is deterministic.
 */

import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { rateLimit } from "@/lib/rate-limit";
import {
  recordTokenAccess,
  verifyFeedToken,
} from "@/lib/calendar/feeds/feedTokens";
import { generateStaffFeed } from "@/lib/calendar/feeds/generateStaffFeed";

export const dynamic = "force-dynamic";

/** Generic 404 — used for every failure mode to defeat enumeration. */
function notFound(): NextResponse {
  return new NextResponse("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Extract the client IP from the request, honoring x-forwarded-for
 *  set by Caddy/nginx. Best-effort; we never block on a missing IP. */
function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() ?? null;
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return null;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ file: string }> },
) {
  const { file } = await context.params;
  if (!file) return notFound();

  // Strip .ics suffix. Apple/Outlook subscription managers REQUIRE
  // a .ics-ending URL for the file association to fire; we accept
  // both with and without (some users paste the URL into Google
  // Calendar's "From URL" which doesn't care).
  const token = file.endsWith(".ics") ? file.slice(0, -4) : file;
  if (!token) return notFound();

  // ─── Token verification ─────────────────────────────────────────
  // verifyFeedToken returns null for any of: malformed input,
  // unknown hash, revoked row. Same 404 response either way.
  const tokenRow = await verifyFeedToken(token);
  if (!tokenRow) return notFound();

  // ─── Rate limits ────────────────────────────────────────────────
  // Per-token: 60 polls / 5 min. Apple's default poll interval is
  // hourly; even an aggressive 5-min iCloud sync settings rebound
  // (12/hr) is well under this.
  const tokenLimit = rateLimit({
    key: `staff_feed_token:${tokenRow.id}`,
    capacity: 60,
    refillTokens: 60,
    windowMs: 5 * 60_000,
  });
  if (!tokenLimit.ok) {
    return new NextResponse("Rate limit exceeded", {
      status: 429,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Retry-After": String(Math.ceil(tokenLimit.retryAfterMs / 1000)),
      },
    });
  }

  // Per-IP: 200 polls / 5 min. Absorbs household NAT — multiple
  // family members each polling their own ZentroMeet feed from the
  // same WAN IP shouldn't trip this.
  const ip = clientIp(req);
  if (ip) {
    const ipLimit = rateLimit({
      key: `staff_feed_ip:${ip}`,
      capacity: 200,
      refillTokens: 200,
      windowMs: 5 * 60_000,
    });
    if (!ipLimit.ok) {
      return new NextResponse("Rate limit exceeded", {
        status: 429,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Retry-After": String(Math.ceil(ipLimit.retryAfterMs / 1000)),
        },
      });
    }
  }

  // ─── Feed generation ────────────────────────────────────────────
  let feed;
  try {
    feed = await generateStaffFeed({
      tenantId: tokenRow.tenantId,
      staffUserId: tokenRow.userId,
    });
  } catch (err) {
    // Generation failure is a 500 we DON'T want to expose. Log
    // server-side, return 404 to the client (token-enumeration
    // defense — same response surface as "no such token").
    console.error("staff-feed generation failed:", err);
    return notFound();
  }

  // Record the access AFTER generation succeeds, so we don't pollute
  // last_accessed_at with failed polls. Fire-and-forget.
  void recordTokenAccess({ tokenId: tokenRow.id, ip });

  // ─── Conditional GET (304 path) ─────────────────────────────────
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === feed.etag) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: feed.etag,
        "Last-Modified": feed.lastModified.toUTCString(),
        "Cache-Control": "private, max-age=300, must-revalidate",
      },
    });
  }
  const ifModifiedSince = req.headers.get("if-modified-since");
  if (ifModifiedSince) {
    const since = new Date(ifModifiedSince);
    if (!isNaN(since.getTime()) && since.getTime() >= feed.lastModified.getTime()) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: feed.etag,
          "Last-Modified": feed.lastModified.toUTCString(),
          "Cache-Control": "private, max-age=300, must-revalidate",
        },
      });
    }
  }

  return new NextResponse(feed.body, {
    status: 200,
    headers: {
      "Content-Type": feed.contentType,
      // inline + .ics filename = Apple Calendar / iCal opens directly
      // in the subscription wizard rather than downloading to disk.
      "Content-Disposition": `inline; filename="${feed.filename}"`,
      ETag: feed.etag,
      "Last-Modified": feed.lastModified.toUTCString(),
      // Five-minute soft cache — short enough that a fresh add/cancel
      // shows up quickly, long enough to absorb tab-bouncing polls.
      "Cache-Control": "private, max-age=300, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      // Observability — useful when an admin asks "is the feed empty?"
      "X-Feed-Event-Count": String(feed.eventCount),
    },
  });
}

/** HEAD support — Apple Calendar uses HEAD to validate the URL when
 *  the user pastes it into the subscription wizard. We mirror GET's
 *  shape but skip body emission. */
export async function HEAD(
  req: NextRequest,
  context: { params: Promise<{ file: string }> },
) {
  const res = await GET(req, context);
  // Strip body — NextResponse doesn't expose a "no body" path on a
  // cloned response, so we build a fresh one from the headers.
  return new NextResponse(null, { status: res.status, headers: res.headers });
}

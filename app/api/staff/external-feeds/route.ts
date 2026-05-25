/**
 * Phase ICAL-3 — external ICS feed management API.
 *
 *   GET  /api/staff/external-feeds    list this user's feeds (URL redacted)
 *   POST /api/staff/external-feeds    add a new feed (validates + initial sync)
 *
 * Authorization mirrors /api/staff/calendar-feed (Phase ICAL-2):
 *   • Default: caller manages their OWN feeds.
 *   • Override: admin or manager may pass ?userId=<other> to act
 *     on behalf — tenant-scoped.
 *
 * URL handling:
 *   • The plaintext URL is accepted ONLY on POST.
 *   • Stored encrypted via lib/crypto.ts (encryptSecret).
 *   • A SHA-256 hash of the normalized URL goes alongside in
 *     normalized_feed_hash for dedup + audit-without-decrypt.
 *   • GET returns only host + path-suffix preview, never the raw URL.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { externalCalendarFeeds, users } from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { rateLimit } from "@/lib/rate-limit";
import { safeFetch } from "@/lib/security/safeFetch";
import { classifyFeedUrl } from "@/lib/calendar/externalFeeds/parseICSFeed";
import {
  syncExternalFeed,
  normalizedFeedHash,
} from "@/lib/calendar/externalFeeds/syncExternalFeed";
import { classifyFeedHealth } from "@/lib/calendar/externalFeeds/feedHealth";

export const dynamic = "force-dynamic";

/** Resolve the target staff user from `?userId=` or fall back to
 *  the caller. Mirrors the Phase ICAL-2 management API pattern. */
async function resolveTargetUser(req: NextRequest) {
  const caller = await requireUser();
  const url = new URL(req.url);
  const explicit = url.searchParams.get("userId");

  if (!explicit || explicit === caller.id) {
    return { caller, targetId: caller.id, tenantId: caller.tenantId };
  }
  if (caller.role !== "admin" && caller.role !== "manager") return null;

  const [target] = await db
    .select({ id: users.id, tenantId: users.tenantId })
    .from(users)
    .where(and(eq(users.id, explicit), eq(users.tenantId, caller.tenantId)))
    .limit(1);
  if (!target) return null;
  return { caller, targetId: target.id, tenantId: caller.tenantId };
}

/** Build a redacted URL preview for the listing UI. We deliberately
 *  do NOT round-trip the full plaintext URL — once it's persisted
 *  encrypted, the only display surface is "host + last 8 chars of
 *  path". Defends against shoulder-surfing + screen-capture leaks. */
function previewUrl(plaintext: string): string {
  try {
    const u = new URL(plaintext);
    const path = u.pathname;
    const tail = path.length > 12 ? `…${path.slice(-8)}` : path;
    return `${u.protocol}//${u.hostname}${tail}`;
  } catch {
    return "(invalid url)";
  }
}

// ─── GET — list ────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const ctx = await resolveTargetUser(req);
    if (!ctx) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const rows = await db
      .select()
      .from(externalCalendarFeeds)
      .where(
        and(
          eq(externalCalendarFeeds.tenantId, ctx.tenantId),
          eq(externalCalendarFeeds.userId, ctx.targetId),
        ),
      );

    const now = new Date();
    const feeds = rows.map((r) => {
      let preview = "(encrypted)";
      try {
        const pt = decryptSecret(r.feedUrlEncrypted);
        if (pt) preview = previewUrl(pt);
      } catch {
        /* keep generic */
      }
      // Phase ICAL-4 — surface health classification + diagnostic
      // fields. Pure function; no extra DB hit.
      const health = classifyFeedHealth(
        {
          isEnabled: r.isEnabled,
          lastSyncedAt: r.lastSyncedAt,
          lastSyncStatus: r.lastSyncStatus,
          consecutiveFailures: r.consecutiveFailures,
          createdAt: r.createdAt,
        },
        now,
      );
      return {
        id: r.id,
        providerLabel: r.providerLabel,
        providerKind: r.providerKind,
        urlPreview: preview,
        isEnabled: r.isEnabled,
        lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
        lastSyncStatus: r.lastSyncStatus,
        lastError: r.lastError,
        nextSyncAfter: r.nextSyncAfter.toISOString(),
        syncDurationMs: r.syncDurationMs,
        eventCount: r.eventCount,
        consecutiveFailures: r.consecutiveFailures,
        health: {
          state: health.state,
          reason: health.reason,
          tone: health.tone,
        },
        createdAt: r.createdAt.toISOString(),
      };
    });

    return NextResponse.json({ feeds });
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── POST — add a feed ─────────────────────────────────────────────

type AddBody = {
  url?: unknown;
  label?: unknown;
};

export async function POST(req: NextRequest) {
  try {
    const ctx = await resolveTargetUser(req);
    if (!ctx) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Per-user rate limit so an admin (or a script) can't slam the
    // SSRF gate or brute-force discovery against internal hosts.
    const rl = rateLimit({
      key: `external_feed_add:${ctx.tenantId}:${ctx.targetId}`,
      capacity: 6,
      refillTokens: 6,
      windowMs: 5 * 60_000,
    });
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many feed adds — please wait a few minutes." },
        { status: 429 },
      );
    }

    let body: AddBody;
    try {
      body = (await req.json()) as AddBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
    const label =
      typeof body.label === "string" && body.label.trim().length > 0
        ? body.label.trim().slice(0, 120)
        : "Imported feed";
    if (!rawUrl || rawUrl.length > 2048) {
      return NextResponse.json(
        { error: "URL is required (max 2048 chars)" },
        { status: 400 },
      );
    }

    // Classify + normalize before persisting.
    const { kind, normalized } = classifyFeedUrl(rawUrl);
    const hash = normalizedFeedHash(normalized);

    // Pre-flight: hit the URL once. This (a) validates SSRF +
    // reachability before we persist a permanent row, and (b) gives
    // the user an immediate "yes it works / no it doesn't" instead
    // of waiting up to 15 minutes for the cron worker. We use a
    // tight timeout (5s) since this is interactive.
    const probe = await safeFetch(normalized, { timeoutMs: 5000, maxBytes: 5 * 1024 * 1024 });
    if (!probe.ok) {
      const status =
        probe.reason === "ssrf_blocked" ? 400
          : probe.reason === "too_large" ? 413
            : probe.reason === "scheme" ? 400
              : 502;
      return NextResponse.json(
        {
          error:
            probe.reason === "ssrf_blocked"
              ? "This URL resolves to a private or reserved address and cannot be imported."
              : probe.reason === "scheme"
                ? "URL must start with https://"
                : probe.reason === "too_large"
                  ? "The feed is too large (5 MB max)."
                  : `Could not reach the feed: ${probe.message}`,
        },
        { status },
      );
    }

    // Dedup check happens at DB level via the unique index, but a
    // friendlier 409 here saves a stack trace.
    const dup = await db
      .select({ id: externalCalendarFeeds.id })
      .from(externalCalendarFeeds)
      .where(
        and(
          eq(externalCalendarFeeds.tenantId, ctx.tenantId),
          eq(externalCalendarFeeds.userId, ctx.targetId),
          eq(externalCalendarFeeds.normalizedFeedHash, hash),
        ),
      )
      .limit(1);
    if (dup.length > 0) {
      return NextResponse.json(
        { error: "This feed URL is already configured for this user." },
        { status: 409 },
      );
    }

    const encrypted = encryptSecret(normalized);
    if (!encrypted) {
      return NextResponse.json({ error: "Failed to secure URL" }, { status: 500 });
    }

    const [inserted] = await db
      .insert(externalCalendarFeeds)
      .values({
        tenantId: ctx.tenantId,
        userId: ctx.targetId,
        providerLabel: label,
        feedUrlEncrypted: encrypted,
        normalizedFeedHash: hash,
        providerKind: kind,
        isEnabled: true,
        // First sync runs immediately below; the worker can skip
        // this row until its next_sync_after passes.
        nextSyncAfter: new Date(Date.now() + 15 * 60_000),
      })
      .returning();

    // Fire the initial sync inline so the user sees "Synced just now"
    // immediately. Errors from the sync are swallowed at the
    // orchestrator and persisted on the row — we surface a partial
    // success here.
    const syncResult = await syncExternalFeed(inserted);

    return NextResponse.json({
      ok: true,
      feed: {
        id: inserted.id,
        providerLabel: inserted.providerLabel,
        providerKind: inserted.providerKind,
        urlPreview: previewUrl(normalized),
        isEnabled: true,
        syncResult: syncResult.ok ? syncResult.status : `failed: ${syncResult.error}`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

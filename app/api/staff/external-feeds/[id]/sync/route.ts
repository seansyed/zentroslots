/**
 * Phase ICAL-3 — manual "sync now" endpoint.
 *
 *   POST /api/staff/external-feeds/:id/sync
 *
 * Triggers an immediate sync of one feed. Same authorization model
 * as PATCH/DELETE on the parent. Rate-limited per-feed so a user
 * can't hammer an upstream provider.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { externalCalendarFeeds, users } from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { syncExternalFeed } from "@/lib/calendar/externalFeeds/syncExternalFeed";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;

    const [row] = await db
      .select()
      .from(externalCalendarFeeds)
      .where(
        and(
          eq(externalCalendarFeeds.id, id),
          eq(externalCalendarFeeds.tenantId, caller.tenantId),
        ),
      )
      .limit(1);
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const isOwner = row.userId === caller.id;
    const isPrivileged = caller.role === "admin" || caller.role === "manager";
    if (!isOwner && !isPrivileged) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Rate limit: per-feed 5/min. Defends the upstream provider
    // from a "click sync 20 times" user.
    const rl = rateLimit({
      key: `external_feed_manual_sync:${row.id}`,
      capacity: 5,
      refillTokens: 5,
      windowMs: 60_000,
    });
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many manual syncs. Wait a minute." },
        { status: 429 },
      );
    }

    // Don't trust client cache of `row` — re-fetch inside sync since
    // syncExternalFeed reads ETag/lastModified from the row state.
    const result = await syncExternalFeed(row);

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, status: result.status, error: result.error },
        { status: 200 }, // The orchestrator already persisted the error;
        // surface as 200 so the UI can render the state from the row.
      );
    }
    return NextResponse.json({ ok: true, status: result.status });
  } catch (err) {
    return errorResponse(err);
  }
}

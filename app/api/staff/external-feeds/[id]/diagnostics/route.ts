/**
 * Phase ICAL-4 — per-feed diagnostics endpoint.
 *
 *   GET /api/staff/external-feeds/:id/diagnostics
 *
 * Returns a redacted, support-safe diagnostics payload for one feed.
 * Used by:
 *   • The staff Calendar tab's "Diagnostics" panel
 *   • Customer support exports (paste into ticket)
 *
 * Authorization: owner OR admin/manager in the same tenant.
 *
 * Hard guarantees from feedDiagnostics.buildFeedDiagnostics():
 *   • Plaintext URL is never returned. Only the host is exposed.
 *   • No event titles, no attendee emails, no token, no ETag value.
 *   • The payload is safe to paste into a public Slack channel.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  externalCalendarFeeds,
  externalFeedEvents,
} from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";
import { buildFeedDiagnostics } from "@/lib/calendar/externalFeeds/feedDiagnostics";

export const dynamic = "force-dynamic";

export async function GET(
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

    // Cached event count — surfaced in diagnostics so support can
    // confirm "the feed reports 50 events; we have 50 in cache".
    const [countRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(externalFeedEvents)
      .where(eq(externalFeedEvents.feedId, row.id));

    const diag = buildFeedDiagnostics(row, {
      cachedEventCount: countRow?.n ?? 0,
    });

    return NextResponse.json({ diagnostics: diag });
  } catch (err) {
    return errorResponse(err);
  }
}

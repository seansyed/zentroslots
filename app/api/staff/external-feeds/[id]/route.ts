/**
 * Phase ICAL-3 — per-feed management endpoints.
 *
 *   PATCH  /api/staff/external-feeds/:id       enable/disable
 *   DELETE /api/staff/external-feeds/:id       remove the feed + cached events
 *   POST   /api/staff/external-feeds/:id/sync  force an immediate sync
 *
 * (The POST for /sync lives in a sibling [id]/sync/route.ts.)
 *
 * Authorization model: same as the parent route. Caller manages
 * their own feeds; admin/manager can act on any user in their
 * tenant.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { externalCalendarFeeds, users } from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Resolve the feed row + verify the caller has authority over it. */
async function resolveFeed(req: NextRequest, feedId: string) {
  const caller = await requireUser();
  const [row] = await db
    .select()
    .from(externalCalendarFeeds)
    .where(
      and(
        eq(externalCalendarFeeds.id, feedId),
        eq(externalCalendarFeeds.tenantId, caller.tenantId),
      ),
    )
    .limit(1);
  if (!row) return null;

  // Caller is either the owner OR an admin/manager in the same tenant.
  const isOwner = row.userId === caller.id;
  const isPrivileged = caller.role === "admin" || caller.role === "manager";
  if (!isOwner && !isPrivileged) return null;

  // Bonus check — if privileged caller is acting on a foreign user,
  // confirm that user is also in this tenant. (Should already be true
  // via the WHERE above, but defense in depth.)
  if (!isOwner) {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, row.userId), eq(users.tenantId, caller.tenantId)))
      .limit(1);
    if (!u) return null;
  }

  return { caller, feed: row };
}

// ─── PATCH — enable/disable ────────────────────────────────────────

type PatchBody = { isEnabled?: unknown; providerLabel?: unknown };

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await resolveFeed(req, id);
    if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

    let body: PatchBody;
    try {
      body = (await req.json()) as PatchBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const updates: Partial<typeof externalCalendarFeeds.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (typeof body.isEnabled === "boolean") {
      updates.isEnabled = body.isEnabled;
      // When re-enabling, schedule an immediate next-sync so the
      // user doesn't wait ~15 min for the cron worker.
      if (body.isEnabled) updates.nextSyncAfter = new Date();
    }
    if (typeof body.providerLabel === "string" && body.providerLabel.trim()) {
      updates.providerLabel = body.providerLabel.trim().slice(0, 120);
    }

    await db
      .update(externalCalendarFeeds)
      .set(updates)
      .where(eq(externalCalendarFeeds.id, ctx.feed.id));

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── DELETE — remove ───────────────────────────────────────────────

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await resolveFeed(req, id);
    if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // CASCADE on external_feed_events handles the cached events.
    await db
      .delete(externalCalendarFeeds)
      .where(eq(externalCalendarFeeds.id, ctx.feed.id));

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

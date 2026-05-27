/**
 * /api/admin/announcements/[id]
 *
 * DELETE — hard-delete an announcement by id.
 * PATCH  — partial update. Accepts every editable field; un-supplied
 *          fields are left untouched. Same zod-validated shape as the
 *          POST in ../route.ts, but every field is optional.
 *
 * GET    — single row lookup. Used by the edit modal on first open if
 *          the list-row data is stale (rare, but safe to support).
 *
 * Editor route fix (2026-05-26): PATCH was missing, so the Edit button
 * on AnnouncementsLuxuryClient.tsx had no working server endpoint —
 * the client-side redirect to /admin/announcements/[id] hit a 404 page
 * and we never reached this layer. Both halves are fixed now.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { announcements } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

// Partial update — every field optional. Server only writes columns
// that were actually supplied (validated below).
const annPatch = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(5000).optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  audience: z.string().min(1).max(40).optional(),
  linkUrl: z.string().url().nullish(),
  linkLabel: z.string().max(80).nullish(),
  /** ISO-8601 timestamp string or null to clear. */
  expiresAt: z.string().datetime().nullish(),
  /** ISO-8601 timestamp string or null to clear. */
  scheduledAt: z.string().datetime().nullish(),
  active: z.boolean().optional(),
  status: z.enum(["draft", "scheduled", "active", "paused", "expired", "archived"]).optional(),
  kind: z.string().min(1).max(30).optional(),
  channels: z.array(z.string().min(1).max(40)).optional(),
  audienceRules: z.record(z.unknown()).optional(),
});

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireSuperAdmin();
    const { id } = await context.params;
    const [row] = await db
      .select()
      .from(announcements)
      .where(eq(announcements.id, id))
      .limit(1);
    if (!row) throw new HttpError(404, "Announcement not found");
    return NextResponse.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireSuperAdmin();
    const { id } = await context.params;
    const input = annPatch.parse(await req.json());

    // Build a typed update object. We only include keys the caller
    // actually supplied — undefined keys are dropped so the DB
    // defaults / prior values are preserved.
    const update: Record<string, unknown> = {};
    if (input.title !== undefined) update.title = input.title;
    if (input.body !== undefined) update.body = input.body;
    if (input.severity !== undefined) update.severity = input.severity;
    if (input.audience !== undefined) update.audience = input.audience;
    if (input.linkUrl !== undefined) update.linkUrl = input.linkUrl ?? null;
    if (input.linkLabel !== undefined) update.linkLabel = input.linkLabel ?? null;
    if (input.expiresAt !== undefined) {
      update.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    }
    if (input.scheduledAt !== undefined) {
      update.scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
    }
    if (input.active !== undefined) update.active = input.active;
    if (input.status !== undefined) update.status = input.status;
    if (input.kind !== undefined) update.kind = input.kind;
    if (input.channels !== undefined) update.channels = input.channels;
    if (input.audienceRules !== undefined) update.audienceRules = input.audienceRules;

    if (Object.keys(update).length === 0) {
      throw new HttpError(400, "No fields to update");
    }

    const [row] = await db
      .update(announcements)
      .set(update)
      .where(eq(announcements.id, id))
      .returning();
    if (!row) throw new HttpError(404, "Announcement not found");
    return NextResponse.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireSuperAdmin();
    const { id } = await context.params;
    const [row] = await db
      .delete(announcements)
      .where(eq(announcements.id, id))
      .returning();
    if (!row) throw new HttpError(404, "Announcement not found");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

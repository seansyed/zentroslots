import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenantFeatureSettings } from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";
import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAGS,
  FEATURE_FLAG_META,
  invalidateTenantFeatures,
  mergeFlags,
  type FeatureFlag,
} from "@/lib/features";
import { audit, ipFromHeaders } from "@/lib/audit";

// GET /api/tenant/features
//
// Returns the resolved flag set for the caller's tenant plus the static
// metadata (label/description/impact) for each toggle. Used by the
// settings page to render the form.
export async function GET() {
  try {
    const admin = await requireRole(["admin"]);
    const row = await db.query.tenantFeatureSettings.findFirst({
      where: eq(tenantFeatureSettings.tenantId, admin.tenantId),
    });
    const resolved = mergeFlags(row?.flags);
    return NextResponse.json({
      flags: resolved,
      defaults: DEFAULT_FEATURE_FLAGS,
      meta: FEATURE_FLAG_META,
      keys: FEATURE_FLAGS,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// PUT /api/tenant/features
//
// Accepts a partial flags object. Unknown keys are silently ignored
// (defense against schema drift). Booleans only. Writes via upsert so
// a tenant who has never visited this page gets a row on first save.
// Cache is invalidated immediately so the next page render sees the
// new value.
const putSchema = z.object({
  flags: z.record(z.string(), z.boolean()),
});

export async function PUT(req: NextRequest) {
  try {
    const admin = await requireRole(["admin"]);
    const body = putSchema.parse(await req.json());

    // Filter to known keys only — anything else is dropped.
    const sanitised: Record<FeatureFlag, boolean> = { ...DEFAULT_FEATURE_FLAGS };
    for (const k of FEATURE_FLAGS) {
      if (typeof body.flags[k] === "boolean") sanitised[k] = body.flags[k]!;
    }

    // Read existing flags so we audit a diff rather than a snapshot.
    const existing = await db.query.tenantFeatureSettings.findFirst({
      where: eq(tenantFeatureSettings.tenantId, admin.tenantId),
    });
    const previous = mergeFlags(existing?.flags);
    const changed: Partial<Record<FeatureFlag, { from: boolean; to: boolean }>> = {};
    for (const k of FEATURE_FLAGS) {
      if (previous[k] !== sanitised[k]) {
        changed[k] = { from: previous[k], to: sanitised[k] };
      }
    }

    if (existing) {
      await db
        .update(tenantFeatureSettings)
        .set({ flags: sanitised, updatedAt: new Date() })
        .where(eq(tenantFeatureSettings.id, existing.id));
    } else {
      await db.insert(tenantFeatureSettings).values({
        tenantId: admin.tenantId,
        flags: sanitised,
      });
    }

    invalidateTenantFeatures(admin.tenantId);

    if (Object.keys(changed).length > 0) {
      audit({
        tenantId: admin.tenantId,
        action: "feature.update",
        actorUserId: admin.id,
        actorLabel: admin.email,
        entityType: "tenant_feature_settings",
        entityId: admin.tenantId,
        metadata: { changed },
        ipAddress: ipFromHeaders(req.headers),
      });
    }

    return NextResponse.json({ ok: true, flags: sanitised });
  } catch (err) {
    return errorResponse(err);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { availability, tenants, users } from "@/db/schema";
import { errorResponse, requireRole, requireUser } from "@/lib/auth";
import {
  defaultWorkspaceHoursSchema,
  readDefaultWorkspaceHours,
} from "@/lib/workspace-hours";

// /api/tenant/workspace-hours — tenant-level default weekly schedule
// (migration 0034). Used as a fallback by lib/availability.ts when a
// staff member has no per-user rows in the `availability` table.
//
// GET returns the current value AND an operational counter
// ("inheritingStaffCount") so the UI can render "N staff currently
// inherit this schedule" without a second round-trip — the counter
// is what powers the workspace-hours page's operational intelligence.
//
// PUT is admin/manager only, tenant-scoped at the WHERE clause.

export async function GET() {
  try {
    const caller = await requireUser();

    const [row] = await db
      .select({ defaultWorkspaceHours: tenants.defaultWorkspaceHours })
      .from(tenants)
      .where(eq(tenants.id, caller.tenantId));

    const hours = readDefaultWorkspaceHours(row?.defaultWorkspaceHours);

    // Count workforce members (admin/manager/staff) who have NO rows
    // in `availability`. Those are the ones inheriting workspace
    // hours. Done with two cheap aggregates to avoid pulling rows.
    // We compute "workforceCount - staffWithRulesCount" so a single
    // SQL pass over each table suffices.
    const workforceRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.tenantId, caller.tenantId));
    const workforceIds = new Set(workforceRows.map((u) => u.id));

    if (workforceIds.size === 0) {
      return NextResponse.json({
        hours,
        inheritingStaffCount: 0,
        workforceCount: 0,
      });
    }

    const withRules = await db
      .selectDistinct({ userId: availability.userId })
      .from(availability)
      .where(eq(availability.tenantId, caller.tenantId));

    let inheriting = 0;
    const withRulesSet = new Set(withRules.map((r) => r.userId));
    for (const id of workforceIds) {
      if (!withRulesSet.has(id)) inheriting++;
    }

    return NextResponse.json({
      hours,
      inheritingStaffCount: inheriting,
      workforceCount: workforceIds.size,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const raw = await req.json();
    const parsed = defaultWorkspaceHoursSchema.parse(raw);

    // Strip undefined keys so the persisted jsonb only contains the
    // keys the operator explicitly set (null = closed; absent = closed).
    const cleaned: Record<string, { start: string; end: string } | null> = {};
    for (const k of ["0", "1", "2", "3", "4", "5", "6"] as const) {
      if (parsed[k] === undefined) continue;
      cleaned[k] = parsed[k] ?? null;
    }

    await db
      .update(tenants)
      .set({
        defaultWorkspaceHours: cleaned,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, admin.tenantId));

    return NextResponse.json({ ok: true, hours: cleaned });
  } catch (err) {
    return errorResponse(err);
  }
}

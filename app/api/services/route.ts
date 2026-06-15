import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, departments, serviceStaff, services, tenants, users } from "@/db/schema";
import { errorResponse, getTenantId, requireRole, HttpError } from "@/lib/auth";
import { canCreateService, getPlan } from "@/lib/plans";
import { serviceSchema } from "@/lib/validation";

// GET: by default tenant-scoped to the caller and limited to active
// services (existing contract preserved). Pass `?include=all` to also
// return inactive services — the admin Services workspace uses this
// so it can surface readiness states without breaking other callers
// (public booking pages, embeds, etc.) that depend on the default
// active-only behavior.
//
// Additive per-service fields (none replace existing fields):
//   color            — service brand color (already in schema)
//   slug             — already in schema
//   departmentCount  — distinct departments via assigned staff
//   departmentNames  — first 3 department names, sorted alphabetically
//   bookingsLast30d  — count of bookings on this service in last 30 days
//
// If the caller is not signed in, returns an empty list — public
// service discovery happens via the per-tenant booking pages.
export async function GET(req: NextRequest) {
  try {
    const tenantId = await getTenantId();
    if (!tenantId) {
      // Diagnostic: every other listing endpoint 401s here; we silently
      // return [] to preserve the public booking-page contract. Log the
      // anonymous miss so we can correlate empty-list reports against
      // expected unauth'd browsing.
      console.log(
        `[services-GET] anonymous request → returning [] | path=${req.nextUrl.pathname}`,
      );
      return NextResponse.json([]);
    }

    const includeAll = req.nextUrl.searchParams.get("include") === "all";

    const whereClause = includeAll
      ? eq(services.tenantId, tenantId)
      : and(eq(services.tenantId, tenantId), eq(services.isActive, 1));

    const rows = await db
      .select({
        id: services.id,
        tenantId: services.tenantId,
        name: services.name,
        slug: services.slug,
        description: services.description,
        durationMinutes: services.durationMinutes,
        price: services.price,
        bufferBefore: services.bufferBefore,
        bufferAfter: services.bufferAfter,
        isActive: services.isActive,
        videoProvider: services.videoProvider,
        color: services.color,
        // Direct department ownership (migration 0032). The primary
        // signal for "this service belongs to this department."
        departmentId: services.departmentId,
        // Wave I follow-up — intake form attachment. Surfaced so the
        // Service editor drawer can pre-select the current form in
        // its dropdown.
        intakeFormId: services.intakeFormId,
      })
      .from(services)
      .where(whereClause);

    const serviceIds = rows.map((r) => r.id);
    if (serviceIds.length === 0) {
      // Diagnostic: separate the "tenant truly has no services" case
      // from "tenant has services but all are inactive". Helps triage
      // mobile reports of "no services found" — if a follow-up query
      // with include=all comes through and returns rows, we know the
      // operator just needs to re-activate.
      if (!includeAll) {
        const [totalRow] = await db
          .select({ c: sql<number>`count(*)::int` })
          .from(services)
          .where(eq(services.tenantId, tenantId));
        const total = Number(totalRow?.c ?? 0);
        console.log(
          `[services-GET] tenant=${tenantId.slice(0, 8)} active=0 total=${total} includeAll=false → likely all-paused, mobile should re-fetch with ?include=all`,
        );
      } else {
        console.log(
          `[services-GET] tenant=${tenantId.slice(0, 8)} active=0 total=0 includeAll=true → tenant has zero services`,
        );
      }
      return NextResponse.json([]);
    }

    // Staff assignments per service (existing shape preserved)
    const staff = await db
      .select({
        serviceId: serviceStaff.serviceId,
        userId: users.id,
        name: users.name,
        email: users.email,
        timezone: users.timezone,
        departmentId: users.departmentId,
      })
      .from(serviceStaff)
      .innerJoin(users, eq(users.id, serviceStaff.userId))
      .where(
        and(
          eq(serviceStaff.tenantId, tenantId),
          inArray(serviceStaff.serviceId, serviceIds)
        )
      );

    const byService = new Map<string, typeof staff>();
    for (const s of staff) {
      const list = byService.get(s.serviceId) ?? [];
      list.push(s);
      byService.set(s.serviceId, list);
    }

    // Department lookup (id → name) for the department chips on each
    // service card. Services link to departments transitively via the
    // staff that deliver them.
    const deptRows = await db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(eq(departments.tenantId, tenantId));
    const deptNameById = new Map(deptRows.map((d) => [d.id, d.name]));

    // Bookings volume per service (last 30 days)
    const last30dStart = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const bookingCounts = await db
      .select({
        serviceId: bookings.serviceId,
        c: sql<number>`count(*)::int`,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, tenantId),
          inArray(bookings.serviceId, serviceIds),
          gte(bookings.createdAt, last30dStart),
        ),
      )
      .groupBy(bookings.serviceId);
    const bookingMap = new Map(bookingCounts.map((b) => [b.serviceId, Number(b.c)]));

    const activeCount = rows.filter((r) => r.isActive === 1).length;
    console.log(
      `[services-GET] tenant=${tenantId.slice(0, 8)} returned=${rows.length} active=${activeCount} inactive=${rows.length - activeCount} includeAll=${includeAll}`,
    );

    return NextResponse.json(
      rows.map((s) => {
        const svcStaff = byService.get(s.id) ?? [];
        const deptIds = new Set<string>();
        for (const u of svcStaff) {
          if (u.departmentId) deptIds.add(u.departmentId);
        }
        const departmentNames = Array.from(deptIds)
          .map((id) => deptNameById.get(id))
          .filter((n): n is string => Boolean(n))
          .sort((a, b) => a.localeCompare(b))
          .slice(0, 3);

        return {
          ...s,
          staff: svcStaff.map(({ serviceId: _sid, departmentId: _did, ...rest }) => rest),
          departmentCount: deptIds.size,
          departmentNames,
          bookingsLast30d: bookingMap.get(s.id) ?? 0,
        };
      })
    );
  } catch (err) {
    console.error("[services-GET] error:", err instanceof Error ? err.message : err);
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const body = serviceSchema.parse(await req.json());

    // ── Plan cap enforcement (Phase 18) ─────────────────────────
    // Block creates when the tenant has hit its active-services
    // cap. New services default to is_active=1 so every create
    // counts immediately. UI surfaces this state too, but the
    // 403 here is the source of truth against API bypass.
    const [tenantRow] = await db
      .select({ currentPlan: tenants.currentPlan })
      .from(tenants)
      .where(eq(tenants.id, admin.tenantId));
    const plan = getPlan(tenantRow?.currentPlan ?? null);
    const [activeCountRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(services)
      .where(and(eq(services.tenantId, admin.tenantId), eq(services.isActive, 1)));
    const activeCount = Number(activeCountRow?.c ?? 0);
    const capability = canCreateService(plan, activeCount);
    if (!capability.allowed) {
      throw new HttpError(403, capability.reason ?? "Plan limit reached");
    }

    // Verify all staff being assigned belong to this admin's tenant.
    if (body.staffUserIds.length > 0) {
      const assignable = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.tenantId, admin.tenantId),
            inArray(users.id, body.staffUserIds)
          )
        );
      if (assignable.length !== body.staffUserIds.length) {
        throw new HttpError(403, "One or more staff users are not in your workspace");
      }
    }

    // Verify the chosen department (if any) belongs to this tenant.
    // Migration 0032 added services.department_id with ON DELETE SET
    // NULL; we still enforce tenant-scoped writes here so a malicious
    // payload can't cross-tenant.
    if (body.departmentId) {
      const dept = await db
        .select({ id: departments.id })
        .from(departments)
        .where(and(eq(departments.id, body.departmentId), eq(departments.tenantId, admin.tenantId)));
      if (dept.length === 0) {
        throw new HttpError(403, "Department not in this workspace");
      }
    }

    const slug =
      body.slug ??
      body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

    const [row] = await db
      .insert(services)
      .values({
        tenantId: admin.tenantId,
        name: body.name,
        slug,
        description: body.description,
        durationMinutes: body.durationMinutes,
        price: body.price,
        bufferBefore: body.bufferBefore,
        bufferAfter: body.bufferAfter,
        videoProvider: body.videoProvider,
        departmentId: body.departmentId ?? null,
      })
      .returning();

    // A service with zero staff is unbookable: every public booking
    // surface (/u/[slug], the booking funnel, /api/slots) inner-joins
    // serviceStaff, so a staff-less service is silently hidden or 404s.
    // When the caller supplies no staff — notably the onboarding wizard,
    // which posts only name + duration — default to linking the creating
    // user so the freshly-created service is immediately bookable.
    // Callers that pass an explicit staff list keep full control.
    const staffToLink =
      body.staffUserIds.length > 0 ? body.staffUserIds : [admin.id];
    await db.insert(serviceStaff).values(
      staffToLink.map((userId) => ({
        serviceId: row.id,
        userId,
        tenantId: admin.tenantId,
      }))
    );

    return NextResponse.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

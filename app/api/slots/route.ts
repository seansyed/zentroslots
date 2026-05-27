import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { serviceStaff, services, users } from "@/db/schema";
import { getAvailableSlots } from "@/lib/availability";
import { errorResponse, getSession, HttpError } from "@/lib/auth";
import { assertResourcesShareTenant } from "@/lib/tenant";
import { slotsQuerySchema } from "@/lib/validation";
import { recommendSlots } from "@/lib/scheduling/intelligence/recommendationEngine";

export async function GET(req: NextRequest) {
  try {
    const params = slotsQuerySchema.parse({
      serviceId: req.nextUrl.searchParams.get("serviceId"),
      staffUserId: req.nextUrl.searchParams.get("staffUserId"),
      date: req.nextUrl.searchParams.get("date"),
      timezone: req.nextUrl.searchParams.get("timezone"),
    });

    // ── Resolve the service (required either way) ──────────────
    const service = await db.query.services.findFirst({
      where: eq(services.id, params.serviceId),
    });
    if (!service || service.isActive !== 1) {
      throw new HttpError(404, "Service not found");
    }

    // ── Mode A: staffUserId="any" — operator-only fan-out ──────
    // Used by the mobile Quick Create sheet. Looks up every eligible
    // staff for this service and unions their availability via the
    // SAME `getAvailableSlots()` call the single-staff path uses.
    // The mobile booking POST sends staffUserId="auto" so the routing
    // engine picks a concrete staff at submit time; the union is just
    // the visibility layer.
    let unionMode = false;
    let staff: typeof users.$inferSelect | null = null;
    let eligibleStaffIds: string[] = [];

    if (params.staffUserId === "any") {
      unionMode = true;
      // Tenant-isolation guard: the caller must be signed in AND
      // belong to the same tenant as the service. Anonymous "any"
      // requests are rejected — public booking flows always go through
      // the staff-specific path (/book/[serviceId]/[staffId]).
      const session = await getSession();
      if (!session) {
        throw new HttpError(401, "Sign in to view service-wide availability");
      }
      if (session.tenantId !== service.tenantId) {
        throw new HttpError(403, "Forbidden");
      }

      const links = await db
        .select({ userId: serviceStaff.userId })
        .from(serviceStaff)
        .where(and(
          eq(serviceStaff.serviceId, service.id),
          eq(serviceStaff.tenantId, service.tenantId),
        ));
      eligibleStaffIds = links.map((l) => l.userId);

      if (eligibleStaffIds.length === 0) {
        // Diagnostic: helps triage "no slots" reports — distinguishes
        // "service has no assigned staff" from "all staff are off today".
        console.log(
          `[slots-GET] mode=any tenant=${service.tenantId.slice(0, 8)} service=${service.id.slice(0, 8)} eligible_staff=0 → empty`,
        );
        return NextResponse.json({ slots: [] });
      }
    } else {
      // ── Mode B: concrete staffUserId — original contract preserved ──
      staff = (await db.query.users.findFirst({
        where: eq(users.id, params.staffUserId),
      })) ?? null;

      if (!staff) throw new HttpError(404, "Staff not found");
      assertResourcesShareTenant(service, staff);

      // Require the staff to actually deliver this service.
      const link = await db.query.serviceStaff.findFirst({
        where: and(
          eq(serviceStaff.serviceId, service.id),
          eq(serviceStaff.userId, staff.id),
          eq(serviceStaff.tenantId, service.tenantId)
        ),
      });
      if (!link) throw new HttpError(404, "Staff does not deliver this service");
    }

    // ── Engine call — same function in both modes, just different staffIds ──
    let slots: string[];
    if (unionMode) {
      // Fan out across all eligible staff in parallel. Each call runs
      // the FULL scheduling engine (working hours, blackouts, buffers,
      // existing bookings, calendar events, group sessions, etc.) for
      // that staff. We then union + sort + dedupe. Mobile never
      // calculates availability — every slot comes from getAvailableSlots().
      const perStaff = await Promise.all(
        eligibleStaffIds.map((sid) =>
          getAvailableSlots({
            staffUserId: sid,
            serviceId: params.serviceId,
            date: params.date,
            timezone: params.timezone,
          }).catch((e) => {
            console.error(
              `[slots-GET] mode=any staff=${sid.slice(0, 8)} engine error:`,
              e instanceof Error ? e.message : e,
            );
            return [] as string[];
          }),
        ),
      );
      const set = new Set<string>();
      for (const arr of perStaff) for (const iso of arr) set.add(iso);
      slots = Array.from(set).sort();
      console.log(
        `[slots-GET] mode=any tenant=${service.tenantId.slice(0, 8)} service=${service.id.slice(0, 8)} date=${params.date} tz=${params.timezone} eligible_staff=${eligibleStaffIds.length} union_slots=${slots.length}`,
      );
    } else {
      slots = await getAvailableSlots({
        staffUserId: params.staffUserId,
        serviceId: params.serviceId,
        date: params.date,
        timezone: params.timezone,
      });
      console.log(
        `[slots-GET] mode=single tenant=${service.tenantId.slice(0, 8)} service=${service.id.slice(0, 8)} staff=${(staff?.id ?? "").slice(0, 8)} date=${params.date} tz=${params.timezone} slots=${slots.length}`,
      );
    }

    // ─── Apply booking rules AFTER the engine — engine signature stays ──
    const now = Date.now();
    const minNoticeMs = (service.minNoticeMinutes ?? 0) * 60_000;
    const maxAdvanceMs = service.maxAdvanceDays ? service.maxAdvanceDays * 24 * 60 * 60_000 : null;
    const filtered = slots.filter((iso) => {
      const t = new Date(iso).getTime();
      if (t - now < minNoticeMs) return false;
      if (maxAdvanceMs !== null && t - now > maxAdvanceMs) return false;
      return true;
    });

    // Phase SMART-1 — opt-in scored slots. Backward compatible:
    // the `slots: string[]` field stays in place. Callers that pass
    // ?include=intelligence (or =scoring) get an ADDITIONAL
    // `intelligence: { scored: ScoredSlot[] }` field with score +
    // labels per slot. Existing consumers see no change.
    //
    // We never fail the request on intelligence errors — the
    // recommender catches its own errors and returns score-less
    // shapes.
    const include = req.nextUrl.searchParams.get("include");
    const customerEmail = req.nextUrl.searchParams.get("customerEmail") || undefined;
    const customerTimezone = req.nextUrl.searchParams.get("customerTimezone") || undefined;

    if (include === "intelligence" || include === "scoring") {
      // Intelligence overlay requires a concrete staff context for
      // personalized scoring. In union mode we skip it and return the
      // unioned slots without the scored layer — callers see no
      // intelligence field rather than an error.
      if (unionMode || !staff) {
        return NextResponse.json({ slots: filtered });
      }
      const scored = await recommendSlots({
        slots: filtered,
        tenantId: service.tenantId,
        serviceId: service.id,
        staffUserId: staff.id,
        date: params.date,
        timezone: params.timezone,
        customerEmail,
        customerTimezone,
      });
      return NextResponse.json({
        slots: filtered,
        intelligence: { scored },
      });
    }

    return NextResponse.json({ slots: filtered });
  } catch (err) {
    console.error("[slots-GET] error:", err instanceof Error ? err.message : err);
    return errorResponse(err);
  }
}

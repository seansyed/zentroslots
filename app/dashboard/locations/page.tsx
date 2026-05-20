import { redirect } from "next/navigation";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, locations, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import LocationsManager from "@/components/dashboard/LocationsManager";
import { getPlan } from "@/lib/plans";

// Locations workspace — premium operational delivery hubs (Phase 15A).
// Page hydrates with:
//   • Plan + maxLocations cap → gates the create CTA + drives upgrade UX
//   • Enriched location rows with operational counters
//   • Workspace timezone → smart default in the create drawer

export const dynamic = "force-dynamic";

export default async function LocationsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard/login");

  const plan = getPlan(tenant.currentPlan);

  const rows = await db
    .select()
    .from(locations)
    .where(eq(locations.tenantId, user.tenantId))
    .orderBy(asc(locations.name));

  // Operational counters — match the /api/locations GET shape so the
  // client can refetch on mutate and get the same data.
  const last30dStart = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const locationIds = rows.map((r) => r.id);

  let staffMap = new Map<string, number>();
  let bookingMap = new Map<string, number>();

  if (locationIds.length > 0) {
    // Services don't carry a location_id today — see /api/locations
    // GET for the matching honest-zero stance. We only count staff
    // and bookings here.
    const [staffCounts, bookingCounts] = await Promise.all([
      db
        .select({ locationId: users.primaryLocationId, c: sql<number>`count(*)::int` })
        .from(users)
        .where(
          and(
            eq(users.tenantId, user.tenantId),
            inArray(users.role, ["admin", "manager", "staff"]),
            inArray(users.primaryLocationId, locationIds),
          ),
        )
        .groupBy(users.primaryLocationId),
      db
        .select({ locationId: bookings.locationId, c: sql<number>`count(*)::int` })
        .from(bookings)
        .where(
          and(
            eq(bookings.tenantId, user.tenantId),
            inArray(bookings.locationId, locationIds),
            gte(bookings.createdAt, last30dStart),
          ),
        )
        .groupBy(bookings.locationId),
    ]);
    staffMap = new Map(staffCounts.map((r) => [r.locationId!, Number(r.c)]));
    bookingMap = new Map(bookingCounts.map((r) => [r.locationId!, Number(r.c)]));
  }

  const initial = rows.map((r) => ({
    id: r.id,
    name: r.name,
    address: r.address ?? null,
    timezone: r.timezone ?? null,
    phone: r.phone ?? null,
    email: r.email ?? null,
    isActive: r.isActive,
    locationType: (r.locationType ?? "physical") as "physical" | "virtual" | "hybrid",
    logoUrl: r.logoUrl ?? null,
    notes: r.notes ?? null,
    staffCount: staffMap.get(r.id) ?? 0,
    serviceCount: 0,
    bookingsLast30d: bookingMap.get(r.id) ?? 0,
  }));

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Locations"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Locations" }]}
    >
      <LocationsManager
        isAdmin={user.role === "admin" || user.role === "manager"}
        defaultTimezone={user.timezone || "UTC"}
        initial={initial}
        plan={{ id: plan.id, name: plan.name, maxLocations: plan.limits.maxLocations }}
      />
    </Shell>
  );
}

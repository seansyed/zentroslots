// Server-only helper: does a tenant have a place to meet in person?
//
// In-person service delivery requires at least one ACTIVE physical OR hybrid
// location in the SAME tenant. The system "Virtual Hub" is location_type =
// 'virtual' and is therefore (correctly) excluded. Tenant-scoped — never
// crosses tenants. Used by the service create/update API to block enabling
// in-person without an eligible location, and by the Services page to drive
// the in-person checkbox state.
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { locations } from "@/db/schema";

export async function tenantHasInPersonLocation(tenantId: string): Promise<boolean> {
  const rows = await db
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.tenantId, tenantId),
        eq(locations.isActive, true),
        inArray(locations.locationType, ["physical", "hybrid"]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Canonical 400 body for "in-person enabled without an eligible location". */
export const LOCATION_REQUIRED_BODY = {
  error: "LOCATION_REQUIRED",
  message: "Add a physical or hybrid location before enabling in-person bookings.",
} as const;

/**
 * Activation integrity — invariants that MUST hold before we accept a
 * "completed" stamp on a tenant. The escape-hatch ("Finish later") flow
 * intentionally bypasses this; only the terminal `POST /complete`
 * endpoint enforces it.
 *
 * The list is short on purpose. Onboarding should leave a tenant in a
 * state where the public booking page WORKS — anything else (branding,
 * payments, automations) is layered polish that the wizard nudges
 * toward but cannot block on.
 *
 * Returned shape is a discriminated union so the API can stream a clean
 * 400 with the specific blockers, and the UI can render them inline.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { availability, services, serviceStaff, tenants } from "@/db/schema";

export type ActivationBlocker =
  | "no_services"
  | "no_staff"
  | "no_availability"
  | "tenant_missing"
  | "tenant_inactive";

export type ActivationCheckResult =
  | { ok: true }
  | { ok: false; blockers: ActivationBlocker[] };

/**
 * Returns ok=true iff the tenant satisfies the minimum activation
 * invariants. Stateless — never writes.
 *
 * One round-trip via SQL EXISTS: cheaper than two COUNT(*) and short-
 * circuits on first match. The tenant.active read is folded in.
 */
export async function checkActivationIntegrity(
  tenantId: string,
  userId: string,
): Promise<ActivationCheckResult> {
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: { id: true, active: true },
  });
  if (!tenant) return { ok: false, blockers: ["tenant_missing"] };
  if (!tenant.active) return { ok: false, blockers: ["tenant_inactive"] };

  // EXISTS short-circuits on first row, unlike COUNT(*) which scans.
  const [row] = await db.execute<{
    has_services: boolean;
    has_bookable_staff: boolean;
    has_availability: boolean;
  }>(sql`
    SELECT
      EXISTS(SELECT 1 FROM ${services} WHERE ${services.tenantId} = ${tenantId}) AS has_services,
      EXISTS(SELECT 1 FROM ${serviceStaff} WHERE ${serviceStaff.tenantId} = ${tenantId}) AS has_bookable_staff,
      EXISTS(SELECT 1 FROM ${availability} WHERE ${availability.userId} = ${userId}) AS has_availability
  `);

  const blockers: ActivationBlocker[] = [];
  if (!row?.has_services) blockers.push("no_services");
  // A service with no staff is unbookable — every public booking surface
  // inner-joins serviceStaff. Block completion so a tenant can never be
  // stamped "live & ready to take bookings" with a booking page nobody
  // can actually use.
  else if (!row?.has_bookable_staff) blockers.push("no_staff");
  if (!row?.has_availability) blockers.push("no_availability");

  return blockers.length === 0 ? { ok: true } : { ok: false, blockers };
}

/**
 * Same data as `checkActivationIntegrity`, served raw for the dashboard
 * checklist. Avoids re-querying when the dashboard page already needs
 * to know `hasServices` + `hasAvailability` for its 5-item checklist.
 */
export async function getDashboardChecklistSummary(
  tenantId: string,
  userId: string,
): Promise<{ hasServices: boolean; hasAvailability: boolean }> {
  const [row] = await db.execute<{
    has_services: boolean;
    has_availability: boolean;
  }>(sql`
    SELECT
      EXISTS(SELECT 1 FROM ${services} WHERE ${services.tenantId} = ${tenantId}) AS has_services,
      EXISTS(SELECT 1 FROM ${availability} WHERE ${availability.userId} = ${userId}) AS has_availability
  `);
  return {
    hasServices: Boolean(row?.has_services),
    hasAvailability: Boolean(row?.has_availability),
  };
}

/**
 * Stable human-readable copy for the blockers (used by the API + UI).
 * Kept here so callers don't drift on wording.
 */
export const ACTIVATION_BLOCKER_COPY: Record<ActivationBlocker, string> = {
  no_services: "Add at least one service before finishing setup.",
  no_staff: "Assign a staff member to a service so it can be booked.",
  no_availability: "Set your weekly availability before finishing setup.",
  tenant_missing: "Workspace not found — please sign in again.",
  tenant_inactive: "This workspace is inactive — contact support.",
};

/**
 * Shared types for the staff routing engine.
 *
 * RoutingMode is a closed union — adding a mode requires adding a
 * picker module (lib/routing/<mode>.ts) and a dispatch arm in
 * assignStaff.ts. The DB stores mode as varchar so future modes don't
 * need a schema migration.
 */

export type RoutingMode =
  | "manual"
  | "round_robin"
  | "least_busy"
  | "priority"
  | "weighted";

export const ROUTING_MODES: readonly RoutingMode[] = [
  "manual",
  "round_robin",
  "least_busy",
  "priority",
  "weighted",
] as const;

export type AssignStaffInput = {
  tenantId: string;
  serviceId: string;
  /** Pinned location id if the booking is location-scoped. Reserved
   *  for future location-pinned pool enforcement; today routes ignore
   *  it and fall back to "any staff who delivers this service". */
  locationId?: string | null;
  /** Time the customer asked for. The eligibility filter respects
   *  internal bookings + external Google busy time + working hours
   *  for this window. */
  startAt: Date;
  endAt: Date;
};

export type AssignStaffResult =
  | {
      ok: true;
      staffId: string;
      mode: RoutingMode;
      /** Human-readable explanation — recorded in audit_logs and shown
       *  in the admin UI's preview pane. Never user-facing. */
      reason: string;
    }
  | {
      ok: false;
      mode: RoutingMode | "no_rule";
      reason: string;
    };

/**
 * The closed shape of a routing rule row, as seen by the engine.
 * Slightly narrower than the DB row (drops timestamps).
 */
export type RoutingRule = {
  id: string;
  serviceId: string | null;
  locationId: string | null;
  mode: RoutingMode;
  enabled: boolean;
  priorityOrder: string[];
  weightedDistribution: Record<string, number>;
};

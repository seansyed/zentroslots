/**
 * Locations API client.
 *
 *   GET    /api/locations          — list (with staffCount / serviceCount /
 *                                     bookingsLast30d operational counters)
 *   POST   /api/locations          — create (admin|manager)
 *   PATCH  /api/locations/:id       — update (admin|manager)
 *   DELETE /api/locations/:id       — delete OR soft-archive (admin|manager)
 *
 * Backend = app/api/locations/route.ts + app/api/locations/[id]/route.ts.
 * The list endpoint paints the whole management surface in a single fetch
 * (counters included). There is NO GET /api/locations/:id endpoint, so
 * `byId` reads the list and finds the row — see the note on byId below.
 *
 * Tenant isolation is server-side (every endpoint derives the tenant from
 * the session). Never send a tenantId.
 */

import { apiGet, apiPatch, apiPost, apiDelete } from "./client";

/** Allowed location types — mirrors the backend zod
 *  `z.enum(["physical", "virtual", "hybrid"])`. Do NOT invent new values
 *  without a matching backend change. */
export type LocationType = "physical" | "virtual" | "hybrid";

export const LOCATION_TYPES: LocationType[] = ["physical", "virtual", "hybrid"];

/** A location row as returned by GET /api/locations.
 *
 *  NOTE: the list endpoint's response mapper does NOT include `isSystem`
 *  (only the create/update endpoints return it via the full row). It is
 *  declared optional here so the detail screen can gate the delete button
 *  defensively — see the byId note + the [id] screen. */
export type Location = {
  id: string;
  name: string;
  address: string | null;
  timezone: string | null;
  phone: string | null;
  email: string | null;
  isActive: boolean;
  locationType: LocationType;
  logoUrl: string | null;
  notes: string | null;
  // Operational counters (list endpoint only). serviceCount is honest-zero
  // backend-side until a future migration adds services.location_id.
  staffCount?: number;
  serviceCount?: number;
  bookingsLast30d?: number;
  // Present on create/update responses; absent from the list payload.
  isSystem?: boolean;
};

/** Create payload — mirrors POST /api/locations zod. `name` required;
 *  everything else optional. locationType defaults to "physical" server-side. */
export type LocationCreateInput = {
  name: string;
  address?: string | null;
  timezone?: string | null;
  phone?: string | null;
  email?: string | null;
  locationType?: LocationType;
  notes?: string | null;
};

/** Update payload — mirrors PATCH /api/locations/:id zod. Adds isActive. */
export type LocationUpdateInput = {
  name?: string;
  address?: string | null;
  timezone?: string | null;
  phone?: string | null;
  email?: string | null;
  locationType?: LocationType;
  notes?: string | null;
  isActive?: boolean;
};

/** DELETE response — backend either hard-deletes (no booking references)
 *  or soft-archives (sets isActive=false when bookings reference it). */
export type LocationDeleteResult = {
  ok: boolean;
  deleted?: boolean;
  archived?: boolean;
};

export const locationsApi = {
  async list(): Promise<Location[]> {
    return apiGet<Location[]>("/api/locations");
  },

  /** Resolve a single location.
   *
   *  There is no GET /api/locations/:id route, so we read the list and
   *  find the row. This keeps tenant isolation intact (the list is already
   *  tenant-scoped) and means the detail screen gets the operational
   *  counters for free. Returns null when the id isn't in the tenant. */
  async byId(id: string): Promise<Location | null> {
    const rows = await locationsApi.list();
    return rows.find((r) => r.id === id) ?? null;
  },

  /** Create a location. Returns the created row (201). May throw
   *  ApiError(402) when the tenant is over its plan's location cap. */
  async create(input: LocationCreateInput): Promise<Location> {
    return apiPost<Location, LocationCreateInput>("/api/locations", input);
  },

  /** Update mutable fields. Returns the updated row. */
  async update(id: string, input: LocationUpdateInput): Promise<Location> {
    return apiPatch<Location, LocationUpdateInput>(`/api/locations/${id}`, input);
  },

  /** Delete (or soft-archive when bookings reference it). Throws
   *  ApiError(409) for system-protected locations (isSystem=true). */
  async remove(id: string): Promise<LocationDeleteResult> {
    return apiDelete<LocationDeleteResult>(`/api/locations/${id}`);
  },
};

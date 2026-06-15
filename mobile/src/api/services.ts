/**
 * Services API client.
 *
 *   GET /api/services?include=all   — list ALL services in the caller's
 *                                     tenant (active + inactive). The
 *                                     mobile filters isActive client-side
 *                                     so it can distinguish three empty
 *                                     states:
 *                                       • tenant has 0 services
 *                                       • tenant has services but all paused
 *                                       • caller is unauthenticated
 *
 * Why `?include=all` instead of the default active-only filter:
 *   The /api/services route ALWAYS returns `[]` for unauth'd requests
 *   (preserves the public booking-page contract). That means "no
 *   services" looks identical to "session lost" looks identical to "all
 *   services paused" — three very different operator problems. By
 *   pulling all services and filtering client-side, the Quick Create
 *   sheet can render the right empty-state copy + recovery action.
 *
 * Used by Quick Create (service picker) and service-accent coloring on
 * cards.
 */

import { apiDelete, apiGet, apiPatch, apiPost } from "./client";

export type Service = {
  id: string;
  tenantId?: string;
  name: string;
  slug?: string | null;
  description?: string | null;
  durationMinutes: number;
  /** Price in CENTS. 0 = free. null = "price on request". */
  price: number | null;
  color?: string | null;
  isActive?: number | boolean;
  /** Optional booking activity over the last 30 days. */
  bookingsLast30d?: number;
  videoProvider?: string | null;
  // Booking-rule fields (already in the /api/services payload). Surfaced so
  // the New Booking date picker can clamp navigation to the service's
  // configured horizon. Server remains authoritative — mobile only uses
  // maxAdvanceDays to DISABLE out-of-horizon days, never to filter slots.
  minNoticeMinutes?: number | null;
  maxAdvanceDays?: number | null;
  bufferBefore?: number | null;
  bufferAfter?: number | null;
  departmentId?: string | null;
};

/** Video-meeting provider — closed enum mirrored from the backend
 *  `serviceSchema` / patchSchema. Read paths tolerate legacy stored
 *  values; only writes are constrained to this set. */
export type ServiceVideoProvider = "google_meet" | "teams" | "zoom" | "none";

/**
 * Create payload — mirrors the backend POST /api/services zod schema
 * (lib/validation.ts → serviceSchema). Only the fields the route
 * actually accepts on CREATE are present:
 *
 *   • name              required, 1–120 chars
 *   • description       optional free text
 *   • durationMinutes   required, 5–480 (8h)
 *   • price             CENTS, integer ≥ 0 (defaults 0 server-side)
 *   • bufferBefore/After integer 0–240 (defaults 0)
 *   • videoProvider     defaults "google_meet" server-side
 *   • staffUserIds      defaults [] → backend auto-links the creator so
 *                       the new service is immediately bookable
 *   • departmentId      optional/nullable
 *
 * NOTE: `color`, `minNoticeMinutes`, and `maxAdvanceDays` are NOT
 * accepted on CREATE by the backend (serviceSchema omits them). `color`
 * can be set afterwards via update(); minNotice/maxAdvance have no write
 * path in either route today (see api/services.ts header + the screen's
 * inline notes).
 */
export type ServiceCreateInput = {
  name: string;
  description?: string;
  durationMinutes: number;
  /** Price in CENTS. Integer ≥ 0. */
  price?: number;
  bufferBefore?: number;
  bufferAfter?: number;
  videoProvider?: ServiceVideoProvider;
  staffUserIds?: string[];
  departmentId?: string | null;
};

/**
 * Update payload — mirrors the backend PATCH /api/services/:id zod
 * schema (app/api/services/[id]/route.ts → patchSchema). Every field is
 * optional (partial update). Adds two fields the CREATE schema lacks:
 *
 *   • color     hex "#rrggbb" (or null to clear)
 *   • isActive  0|1 or boolean — the activate/deactivate toggle
 *
 * Like CREATE, the PATCH schema does NOT accept minNoticeMinutes /
 * maxAdvanceDays — those remain a backend gap.
 */
export type ServiceUpdateInput = {
  name?: string;
  description?: string | null;
  durationMinutes?: number;
  /** Price in CENTS. Integer ≥ 0. */
  price?: number;
  bufferBefore?: number;
  bufferAfter?: number;
  /** Hex "#rrggbb" or null to clear. */
  color?: string | null;
  /** 0 | 1 (or boolean) — drives the activate/deactivate toggle. */
  isActive?: number | boolean;
  videoProvider?: ServiceVideoProvider;
  staffUserIds?: string[];
  departmentId?: string | null;
};

/** Richer return shape that lets the UI distinguish empty states. */
export type ServiceListResult = {
  /** Active services only — what the booking flow should offer. */
  active: Service[];
  /** Every service in the tenant (active + inactive). */
  all: Service[];
  /** True if the tenant has any services at all (active or not). */
  hasAny: boolean;
  /** True if there are services but every single one is paused. */
  allInactive: boolean;
};

function isActiveTrue(s: Service): boolean {
  // Wire shape uses `0|1`; tolerate the boolean variant for safety.
  return s.isActive === 1 || s.isActive === true;
}

export const servicesApi = {
  async list(): Promise<ServiceListResult> {
    // include=all so empty active doesn't mean empty period — see file header.
    const raw = await apiGet<Service[]>("/api/services?include=all");
    const all = Array.isArray(raw) ? raw : [];
    const active = all.filter(isActiveTrue);
    return {
      active,
      all,
      hasAny: all.length > 0,
      allInactive: all.length > 0 && active.length === 0,
    };
  },

  /**
   * Fetch a single service by id.
   *
   * The backend exposes NO `GET /api/services/:id` route — the `[id]`
   * route only handles PATCH + DELETE. So we resolve a single service
   * from the tenant-scoped `?include=all` list (active + inactive) and
   * pick the match. This keeps the detail screen working off the same
   * authoritative payload the list uses, and the FRESHNESS contract in
   * useServices applies equally here.
   *
   * Returns null when no service with `id` exists in the caller's
   * tenant (deleted, or cross-tenant id) so the screen can render a
   * "not found" state instead of throwing.
   */
  async byId(id: string): Promise<Service | null> {
    const raw = await apiGet<Service[]>("/api/services?include=all");
    const all = Array.isArray(raw) ? raw : [];
    return all.find((s) => s.id === id) ?? null;
  },

  /**
   * Create a service. Backend returns the freshly-inserted row and
   * auto-links the creating user as staff when `staffUserIds` is empty,
   * so the new service is immediately bookable. Throws ApiError(403)
   * when the tenant's plan active-services cap is reached.
   */
  async create(input: ServiceCreateInput): Promise<Service> {
    return apiPost<Service, ServiceCreateInput>("/api/services", input);
  },

  /**
   * Patch mutable fields. Throws ApiError(403) when re-activating a
   * service would exceed the plan cap (the screen surfaces the server
   * message verbatim). Returns the fresh row.
   */
  async update(id: string, input: ServiceUpdateInput): Promise<Service> {
    return apiPatch<Service, ServiceUpdateInput>(`/api/services/${id}`, input);
  },

  /**
   * Delete a service. The backend soft-deletes (sets isActive=0) when
   * the service has any bookings, and hard-deletes only when it's safe.
   * Response shape: `{ ok: true, archived?: true, deleted?: true }`.
   */
  async remove(id: string): Promise<{ ok: boolean; archived?: boolean; deleted?: boolean }> {
    return apiDelete<{ ok: boolean; archived?: boolean; deleted?: boolean }>(
      `/api/services/${id}`,
    );
  },
};

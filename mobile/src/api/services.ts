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

import { apiGet } from "./client";

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
};

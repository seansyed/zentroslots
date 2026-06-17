/**
 * Customers API client.
 *
 *   GET    /api/customers           — list, optional ?q=
 *   GET    /api/customers/:id       — single, with bookingHistory[]
 *   POST   /api/customers           — create (not used by mobile yet)
 *
 * The list endpoint returns booking-aggregate fields per customer
 * (total/completed/cancelled/lastAppointmentAt) which we surface
 * directly in the list UI so a single fetch can paint the whole CRM.
 */

import { apiGet, apiPatch, apiPost } from "./client";
import { absolutizeUrl } from "@/lib/url";
import { env } from "@/lib/env";
import { deriveStatsFromHistory } from "@/lib/customerStats";

export type CustomerStatus = "active" | "vip" | "archived" | "prospect";

/** Create payload — mirrors the backend POST /api/customers zod schema.
 *  name + email required; everything else optional. */
export type CustomerCreateInput = {
  name: string;
  email: string;
  phone?: string | null;
  notes?: string | null;
  status?: CustomerStatus;
  tags?: string[];
};

/** Update payload — mirrors backend PATCH /api/customers/:id. NOTE: the
 *  backend PATCH schema does NOT accept `email` (email is set at create),
 *  so edits cover name/phone/notes/status/tags only. */
export type CustomerUpdateInput = {
  name?: string;
  phone?: string | null;
  notes?: string | null;
  status?: CustomerStatus;
  tags?: string[];
};

export type Customer = {
  id: string;
  // The detail endpoint historically wrapped its payload as
  // { customer, history } while the list endpoint already returns a
  // flat row. Production data also contains rows where name was never
  // captured (CSV imports, half-completed bookings) — so the field is
  // optional / nullable at the type level even though the schema is
  // NOT NULL, because the wire response may still surface as undefined
  // after the detail endpoint's wrapper unwrap if any caller forgets.
  name: string | null;
  email: string | null;
  phone: string | null;
  status: CustomerStatus;
  tags: string[];
  // Optional + nullable for defensive rendering — see CustomerDetail
  // screen for the safe formatter that handles undefined / Invalid Date.
  createdAt?: string | null;
  /** Last-modified, used as a cache-busting key for the avatar image. */
  updatedAt?: string | null;
  /** Customer profile image, absolutized against the API origin (RN <Image>
   *  can't load relative /uploads paths — see lib/url.ts). The product does NOT
   *  currently store customer photos (no DB column / upload path; web also shows
   *  initials), so this is null today and the Avatar falls back to initials.
   *  Wired forward-compatibly: the instant the backend returns an image field,
   *  it renders here with no further mobile change. */
  imageUrl?: string | null;
  totalBookings: number;
  completed: number;
  cancelled: number;
  lastAppointmentAt: string | null;
};

/** Absolutize a customer's image URL (relative /uploads → API origin). Tolerates
 *  several possible backend field names so it lights up whatever the API ships. */
function withImageUrl<T extends { imageUrl?: string | null; avatarUrl?: string | null; image?: string | null }>(
  row: T,
): T & { imageUrl: string | null } {
  const raw = row.imageUrl ?? row.avatarUrl ?? row.image ?? null;
  return { ...row, imageUrl: absolutizeUrl(raw, env.apiBaseUrl) };
}

export type CustomerListResponse = Customer[];

export type CustomerHistoryItem = {
  id: string;
  serviceName?: string | null;
  staffName?: string | null;
  startAt: string;
  endAt: string;
  status: string;
  amountCents?: number | null;
  /** Server viewer-tz display labels (matches appointments). */
  startLabel?: string | null;
  endLabel?: string | null;
  startDayLabel?: string | null;
};

export type CustomerDetail = Customer & {
  notes?: string | null;
  bookingHistory?: CustomerHistoryItem[];
};

export const customersApi = {
  async list(params: { q?: string } = {}): Promise<CustomerListResponse> {
    const search: Record<string, string> = {};
    if (params.q) search.q = params.q;
    const rows = await apiGet<CustomerListResponse>("/api/customers", { params: search });
    return (Array.isArray(rows) ? rows : []).map(withImageUrl);
  },

  /** Create a customer. Backend returns the created row (201). Throws
   *  ApiError(409) if a customer with this email already exists in the
   *  tenant — the form surfaces that as a duplicate warning. */
  async create(input: CustomerCreateInput): Promise<Customer> {
    return apiPost<Customer, CustomerCreateInput>("/api/customers", input);
  },

  /** Update mutable fields (name/phone/notes/status/tags). */
  async update(id: string, input: CustomerUpdateInput): Promise<Customer> {
    return apiPatch<Customer, CustomerUpdateInput>(`/api/customers/${id}`, input);
  },

  /** Archive (soft-delete): the product has no hard-delete — archiving
   *  sets status="archived" and preserves all booking history. */
  async archive(id: string): Promise<Customer> {
    return apiPatch<Customer, CustomerUpdateInput>(`/api/customers/${id}`, {
      status: "archived",
    });
  },

  /** Restore an archived customer back to active. */
  async unarchive(id: string): Promise<Customer> {
    return apiPatch<Customer, CustomerUpdateInput>(`/api/customers/${id}`, {
      status: "active",
    });
  },

  async byId(id: string): Promise<CustomerDetail> {
    // The detail endpoint returns a wrapped shape:
    //   { customer: {...}, history: [...] }
    // Older / mirrored backends may return a flat shape directly. Accept
    // BOTH to stay forward-compatible (and to keep us alive during a
    // staged rollout that flips the shape).
    type Wire =
      | (CustomerDetail & { customer?: undefined; history?: undefined })
      | {
          customer: CustomerDetail;
          history: CustomerHistoryItem[] | null;
        };
    const raw = await apiGet<Wire>(`/api/customers/${id}`);
    // Wrapped shape: { customer, history } → flatten. Derived stats are spread
    // LAST so they override the raw row's missing/zero aggregates.
    if (raw && typeof raw === "object" && "customer" in raw && raw.customer) {
      const history = Array.isArray(raw.history) ? raw.history : [];
      return {
        ...withImageUrl(raw.customer),
        bookingHistory: history,
        ...deriveStatsFromHistory(history),
      };
    }
    // Already flat — pass through, but make sure bookingHistory is an
    // array so the screen never needs to check.
    const flat = raw as CustomerDetail;
    const history = Array.isArray(flat.bookingHistory) ? flat.bookingHistory : [];
    return {
      ...withImageUrl(flat),
      bookingHistory: history,
      ...deriveStatsFromHistory(history),
    };
  },
};

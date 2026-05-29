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

import { apiGet } from "./client";

export type CustomerStatus = "active" | "vip" | "archived" | "prospect";

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
  totalBookings: number;
  completed: number;
  cancelled: number;
  lastAppointmentAt: string | null;
};

export type CustomerListResponse = Customer[];

export type CustomerHistoryItem = {
  id: string;
  serviceName?: string | null;
  staffName?: string | null;
  startAt: string;
  endAt: string;
  status: string;
  amountCents?: number | null;
};

export type CustomerDetail = Customer & {
  notes?: string | null;
  bookingHistory?: CustomerHistoryItem[];
};

export const customersApi = {
  async list(params: { q?: string } = {}): Promise<CustomerListResponse> {
    const search: Record<string, string> = {};
    if (params.q) search.q = params.q;
    return apiGet<CustomerListResponse>("/api/customers", { params: search });
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
    // Wrapped shape: { customer, history } → flatten.
    if (raw && typeof raw === "object" && "customer" in raw && raw.customer) {
      return {
        ...raw.customer,
        bookingHistory: Array.isArray(raw.history) ? raw.history : [],
      };
    }
    // Already flat — pass through, but make sure bookingHistory is an
    // array so the screen never needs to check.
    const flat = raw as CustomerDetail;
    return {
      ...flat,
      bookingHistory: Array.isArray(flat.bookingHistory) ? flat.bookingHistory : [],
    };
  },
};

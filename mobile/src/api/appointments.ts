/**
 * Appointments / bookings endpoints.
 *
 * Backend list endpoint is GET /api/bookings (NOT /api/tenant/appointments —
 * that's POST-only for admin creation). It accepts:
 *   • ?status=pending|confirmed|cancelled|completed|no_show
 *   • ?cursor=<ISO timestamp> + ?limit=<n>
 *
 * It returns a raw array of bookings (no { rows, nextCursor } wrapper).
 * We normalize that here so screens don't learn the wire shape.
 */

import { apiDelete, apiGet, apiPost } from "./client";

export type BookingStatus =
  | "pending"
  | "confirmed"
  | "completed"
  | "cancelled"
  | "no_show"
  | "rescheduled";

export type Appointment = {
  id: string;
  serviceId?: string | null;
  serviceName: string;
  staffId?: string | null;
  staffName: string;
  clientId?: string | null;
  clientName: string;
  clientEmail: string;
  clientPhone?: string | null;
  startAt: string;
  endAt: string;
  status: BookingStatus;
  meetingProvider?: "google_meet" | "microsoft_teams" | "zoom" | "in_person" | "phone" | null;
  meetLink?: string | null;
  location?: string | null;
  amountCents?: number | null;
  notes?: string | null;
};

export type AppointmentListParams = {
  from?: string;
  to?: string;
  status?: BookingStatus;
  cursor?: string;
  limit?: number;
};

export type AppointmentListResponse = {
  rows: Appointment[];
  nextCursor: string | null;
};

/** The wire shape is sparser than our Appointment type. Anything we
 *  don't have on the wire gets a sensible default — the UI never
 *  branches on null/undefined for these fields. */
type WireBooking = {
  id: string;
  startAt: string;
  endAt: string;
  status: BookingStatus;
  clientName: string;
  clientEmail: string;
  notes?: string | null;
  meetLink?: string | null;
  serviceId?: string | null;
  staffUserId?: string | null;
};

function normalize(wire: WireBooking): Appointment {
  return {
    id: wire.id,
    serviceId: wire.serviceId ?? null,
    serviceName: "Appointment",
    staffId: wire.staffUserId ?? null,
    staffName: "Staff",
    clientId: null,
    clientName: wire.clientName,
    clientEmail: wire.clientEmail,
    clientPhone: null,
    startAt: wire.startAt,
    endAt: wire.endAt,
    status: wire.status,
    meetingProvider: null,
    meetLink: wire.meetLink ?? null,
    location: null,
    amountCents: null,
    notes: wire.notes ?? null,
  };
}

export const appointmentsApi = {
  async list(params: AppointmentListParams = {}): Promise<AppointmentListResponse> {
    const search: Record<string, string> = {};
    if (params.status) search.status = params.status;
    if (params.cursor) search.cursor = params.cursor;
    if (params.limit) search.limit = String(params.limit);

    const raw = await apiGet<WireBooking[] | { rows: WireBooking[]; nextCursor?: string | null }>(
      "/api/bookings",
      { params: search },
    );
    const wire = Array.isArray(raw) ? raw : (raw.rows ?? []);
    const nextCursor = Array.isArray(raw) ? null : raw.nextCursor ?? null;

    let rows = wire.map(normalize);
    // Date filtering is client-side because the bookings endpoint only
    // supports cursor pagination. Cheap for the page-sized result sets
    // mobile fetches (≤ 200 rows).
    if (params.from) {
      const from = new Date(params.from).getTime();
      rows = rows.filter((r) => new Date(r.startAt).getTime() >= from);
    }
    if (params.to) {
      const to = new Date(params.to).getTime();
      rows = rows.filter((r) => new Date(r.startAt).getTime() < to);
    }
    return { rows, nextCursor };
  },

  async byId(id: string): Promise<Appointment> {
    // The GET /api/bookings/[id] endpoint returns a richer joined
    // shape than the list endpoint (service.name, staff.name, customer
    // phone, internal notes for managerial roles). We normalize to
    // the same Appointment type so consumers don't branch on the
    // source.
    type WireBookingDetail = WireBooking & {
      internalNotes?: string | null;
      clientPhone?: string | null;
      meetingProvider?: Appointment["meetingProvider"];
      location?: string | null;
      amountCents?: number | null;
      service?: { id: string | null; name: string; description?: string | null };
      staff?: { id: string | null; name: string };
    };
    const w = await apiGet<WireBookingDetail>(`/api/bookings/${id}`);
    return {
      ...normalize(w),
      serviceId: w.service?.id ?? w.serviceId ?? null,
      serviceName: w.service?.name ?? "Appointment",
      staffId: w.staff?.id ?? w.staffUserId ?? null,
      staffName: w.staff?.name ?? "Staff",
      clientPhone: w.clientPhone ?? null,
      meetingProvider: w.meetingProvider ?? null,
      location: w.location ?? null,
      amountCents: w.amountCents ?? null,
      notes: w.notes ?? null,
    };
  },

  cancel(id: string): Promise<{ ok: true }> {
    return apiPost(`/api/bookings/${id}/cancel`);
  },

  /**
   * Transition a booking to a new status. Used by operator quick
   * actions: confirm a pending booking, mark completed, mark no-show.
   * Backend route is POST /api/bookings/[id]/status with `{ status }`
   * — managerial role or booking-owner-staff gated server-side.
   */
  setStatus(id: string, status: BookingStatus): Promise<{ id: string; status: BookingStatus }> {
    return apiPost(`/api/bookings/${id}/status`, { status });
  },

  /**
   * Reschedule a booking. Backend only needs `startAt` — it recomputes
   * endAt from the service's durationMinutes. Returns the updated booking.
   */
  reschedule(id: string, payload: { startAt: string }): Promise<Appointment> {
    return apiPost<WireBooking>(`/api/bookings/${id}/reschedule`, payload).then(normalize);
  },

  /**
   * Create a booking via the public booking endpoint. The schema
   * accepts staffUserId as a uuid OR the literal "auto" (routes via
   * the routing engine). endAt is derived server-side from the
   * service's durationMinutes — no need to send it.
   *
   * Used by mobile Quick Create. Returns the normalized booking.
   */
  create(payload: {
    serviceId: string;
    staffUserId: string | "auto";
    startAt: string;
    clientName: string;
    clientEmail: string;
    notes?: string;
  }): Promise<Appointment> {
    return apiPost<WireBooking>("/api/bookings", payload).then(normalize);
  },

  /**
   * Available slots for a given service+staff+date. Mirrors GET /api/slots.
   * `date` is YYYY-MM-DD in the *staff* timezone; the engine returns ISO
   * timestamps which the UI formats in the device's local time.
   */
  async slots(params: {
    serviceId: string;
    staffUserId: string;
    date: string;
    timezone: string;
  }): Promise<string[]> {
    const res = await apiGet<{ slots: string[] }>("/api/slots", {
      params: {
        serviceId: params.serviceId,
        staffUserId: params.staffUserId,
        date: params.date,
        timezone: params.timezone,
      },
    });
    return Array.isArray(res?.slots) ? res.slots : [];
  },

  remove(id: string): Promise<{ ok: true }> {
    return apiDelete(`/api/bookings/${id}`);
  },
};

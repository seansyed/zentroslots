/**
 * Appointments / bookings endpoints.
 *
 * Backend list endpoint is GET /api/bookings (NOT /api/tenant/appointments —
 * that's POST-only for admin creation). It accepts:
 *   • ?status=pending|confirmed|cancelled|completed|no_show
 *   • ?cursor=<ISO timestamp> + ?limit=<n>
 *
 * It returns `{ rows, nextCursor }` (DESC by startAt, 90-day floor). Older
 * builds returned a raw array, so the client tolerates both shapes. We
 * normalize here so screens don't learn the wire shape.
 */

import { apiDelete, apiGet, apiPost } from "./client";
import type { IntakeAnswer } from "./intake";

// Mirrors the backend bookingStatusEnum (db/schema.ts) exactly. "pending_payment"
// is a paid booking awaiting settlement; "payment_failed"/"refunded" are terminal
// payment outcomes. (The old "rescheduled" was never a DB value — removed.)
export type BookingStatus =
  | "pending"
  | "confirmed"
  | "pending_payment"
  | "payment_failed"
  | "cancelled"
  | "completed"
  | "no_show"
  | "refunded";

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
  /** Managerial-only internal note, returned by the detail endpoint
   *  (GET /api/bookings/[id]) — absent on the list shape. */
  internalNotes?: string | null;
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

/** One bookable slot, ready to display + book. `start` is the ISO-8601 UTC
 *  instant (sent verbatim on booking); `label` is the server-formatted local
 *  time ("9:00 AM") in the authoritative timezone. */
export type SlotDisplay = { start: string; label: string };

/** /api/slots result: raw instants + authoritative tz + display rows. */
export type SlotsResult = {
  slots: string[];
  timezone: string;
  display: SlotDisplay[];
};

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
      internalNotes: w.internalNotes ?? null,
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
    /** Service-template intake answers, keyed by field.key. Only sent when the
     *  selected service has an active intake form (e.g. a tax service's
     *  "filing_status"). The backend re-validates against the form definition
     *  and dual-writes them to the booking. Omit for services without a form. */
    intakeResponses?: Record<string, unknown>;
  }): Promise<Appointment> {
    return apiPost<WireBooking>("/api/bookings", payload).then(normalize);
  },

  /**
   * Submitted intake answers for a booking, labeled + role-gated by the
   * backend (GET /api/bookings/:id/intake-responses). Used by the appointment
   * detail screen's "Service details" card. Reads the normalized
   * intake_field_responses table (snapshots labels, so historical answers
   * survive later template edits) and falls back to the legacy jsonb. Returns
   * [] when the booking has no answers or the caller lacks access.
   */
  async intakeResponses(id: string): Promise<IntakeAnswer[]> {
    const res = await apiGet<{ responses?: IntakeAnswer[] }>(
      `/api/bookings/${id}/intake-responses`,
    );
    return Array.isArray(res?.responses) ? res.responses : [];
  },

  /**
   * Available slots for a service+staff+date. Mirrors GET /api/slots.
   *
   * `date` is YYYY-MM-DD; `timezone` is the authoritative (tenant/operator)
   * IANA zone. The backend returns ISO-8601 UTC instants in `slots` AND a
   * parallel `display[]` of { start (ISO, booked verbatim), label ("9:00 AM"
   * formatted ONCE server-side in the authoritative tz) } plus the canonical
   * `timezone`. The UI renders `display[].label` and books `display[].start`
   * — it never formats the instant itself (Hermes can't format IANA zones,
   * and device-tz formatting was producing wrong times like "2 AM" for 9–6
   * working hours). Falls back gracefully if an older backend omits `display`.
   */
  async slots(params: {
    serviceId: string;
    staffUserId: string;
    date: string;
    timezone: string;
  }): Promise<SlotsResult> {
    const res = await apiGet<{
      slots?: string[];
      timezone?: string;
      display?: SlotDisplay[];
    }>("/api/slots", {
      params: {
        serviceId: params.serviceId,
        staffUserId: params.staffUserId,
        date: params.date,
        timezone: params.timezone,
      },
    });
    const slots = Array.isArray(res?.slots) ? res.slots : [];
    const timezone = res?.timezone || params.timezone;
    const display =
      Array.isArray(res?.display) && res.display.length === slots.length
        ? res.display
        : // Fallback for a pre-deploy backend: show the UTC wall-clock so the
          // value is never a raw ISO string (still authoritative-safe — no
          // device-tz guess). The deployed backend always sends labels.
          slots.map((s) => ({ start: s, label: s.slice(11, 16) }));
    return { slots, timezone, display };
  },

  remove(id: string): Promise<{ ok: true }> {
    return apiDelete(`/api/bookings/${id}`);
  },
};

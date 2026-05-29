/**
 * useBookingActions — shared mutation hooks for booking status
 * transitions and cancellation.
 *
 * Used by:
 *   • Appointment detail screen — Confirm + Cancel sticky CTAs.
 *   • Notifications inbox       — Confirm inline action on pending rows.
 *
 * Both call sites get the same optimistic update + rollback semantics
 * so the UI feels instant even on slow links, and we keep the data
 * truthy by invalidating the relevant queries onSettled.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { appointmentsApi, type Appointment, type BookingStatus } from "@/api/appointments";
import { queryKeys } from "@/lib/query";

/** Patch a single appointment row inside the cached list result. */
function patchAppointmentInListCache(
  client: ReturnType<typeof useQueryClient>,
  id: string,
  patch: Partial<Appointment>,
) {
  client
    .getQueryCache()
    .findAll({ queryKey: queryKeys.appointments() })
    .forEach((q) => {
      const data = q.state.data as
        | { rows?: Appointment[]; nextCursor?: string | null }
        | undefined;
      if (!data?.rows) return;
      const idx = data.rows.findIndex((r) => r.id === id);
      if (idx === -1) return;
      const nextRows = data.rows.slice();
      nextRows[idx] = { ...nextRows[idx]!, ...patch };
      client.setQueryData(q.queryKey, { ...data, rows: nextRows });
    });
}

export function useConfirmBooking() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => appointmentsApi.setStatus(id, "confirmed"),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: queryKeys.appointment(id) });
      const previous = client.getQueryData<Appointment | undefined>(queryKeys.appointment(id));
      // Detail cache
      client.setQueryData(queryKeys.appointment(id), (prev: Appointment | undefined) =>
        prev ? { ...prev, status: "confirmed" as BookingStatus } : prev,
      );
      // List caches (Home, Bookings tab) — patch in place so the badge
      // count + status pill update instantly without a refetch round-trip.
      patchAppointmentInListCache(client, id, { status: "confirmed" });
      return { previous, id };
    },
    onError: (_err, id, ctx) => {
      if (ctx?.previous) {
        client.setQueryData(queryKeys.appointment(id), ctx.previous);
      }
      // Refetch lists to undo the in-place patches accurately.
      void client.invalidateQueries({ queryKey: queryKeys.appointments() });
    },
    onSettled: (_data, _err, id) => {
      void client.invalidateQueries({ queryKey: queryKeys.appointments() });
      void client.invalidateQueries({ queryKey: queryKeys.appointment(id) });
    },
  });
}

export function useCancelBooking() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => appointmentsApi.cancel(id),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: queryKeys.appointment(id) });
      const previous = client.getQueryData<Appointment | undefined>(queryKeys.appointment(id));
      client.setQueryData(queryKeys.appointment(id), (prev: Appointment | undefined) =>
        prev ? { ...prev, status: "cancelled" as BookingStatus } : prev,
      );
      patchAppointmentInListCache(client, id, { status: "cancelled" });
      return { previous, id };
    },
    onError: (_err, id, ctx) => {
      if (ctx?.previous) {
        client.setQueryData(queryKeys.appointment(id), ctx.previous);
      }
      void client.invalidateQueries({ queryKey: queryKeys.appointments() });
    },
    onSettled: (_data, _err, id) => {
      void client.invalidateQueries({ queryKey: queryKeys.appointments() });
      void client.invalidateQueries({ queryKey: queryKeys.appointment(id) });
    },
  });
}

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { appointmentsApi, type Appointment, type AppointmentListParams } from "@/api/appointments";
import { queryKeys } from "@/lib/query";
import { selectUpcoming } from "@/lib/upcoming";

export function useAppointments(params: AppointmentListParams = {}) {
  return useQuery({
    queryKey: queryKeys.appointments(params),
    queryFn: () => appointmentsApi.list(params),
  });
}

/**
 * Soonest upcoming bookings for the Home "Up next" section.
 *
 * The backend list endpoint orders DESC by startAt over a fixed 90-day floor
 * with no server-side date range, so the old Home query (no status filter +
 * a client-side +32d clip on a newest-200 page) let cancelled/completed rows
 * consume the page and discarded near-term bookings — the section read empty.
 *
 * Here we fetch by STATUS (confirmed + pending) so the page isn't diluted by
 * cancelled/completed/no_show, drop the date clip, then filter to startAt>=now,
 * sort ASCENDING, and take the soonest `count`. This is correct for the realistic
 * tenant scale (a status-filtered page of 200 contains all of an SMB's upcoming
 * bookings). Edge note: a tenant with >200 FUTURE confirmed bookings could still
 * have its soonest paged out by the DESC order — the robust fix for that scale
 * would be a backend asc/from param (out of scope; no backend change here).
 *
 * `refetchOnMount: "always"` means returning to Home after creating/confirming/
 * rescheduling a booking reflects it immediately (mutations also invalidate the
 * appointments key).
 */
export function useUpcomingAppointments(count = 3) {
  const confirmedQ = useQuery({
    queryKey: queryKeys.appointments({ status: "confirmed", limit: 200 }),
    queryFn: () => appointmentsApi.list({ status: "confirmed", limit: 200 }),
    refetchOnMount: "always",
  });
  const pendingQ = useQuery({
    queryKey: queryKeys.appointments({ status: "pending", limit: 100 }),
    queryFn: () => appointmentsApi.list({ status: "pending", limit: 100 }),
    refetchOnMount: "always",
  });

  // `now` advances every time either query gets fresh data. The Home tab stays
  // mounted across tab switches (expo-router Tabs persist), so a frozen mount-
  // time `now` would let a just-passed booking linger. Tying it to dataUpdatedAt
  // means any refresh — pull-to-refresh, AppState-foreground invalidation
  // (useAppLifecycle), a booking mutation invalidation, or the focus refetch
  // below — also re-evaluates the >=now cutoff and drops bookings that elapsed.
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    setNowMs(Date.now());
  }, [confirmedQ.dataUpdatedAt, pendingQ.dataUpdatedAt]);

  const upcoming = React.useMemo<Appointment[]>(() => {
    const rows = [
      ...(confirmedQ.data?.rows ?? []),
      ...(pendingQ.data?.rows ?? []),
    ];
    return selectUpcoming(rows, nowMs, count);
  }, [confirmedQ.data, pendingQ.data, nowMs, count]);

  // Depend on the (stable) inner refetch fns, not the query objects, so this
  // wrapper is itself stable — a focus effect can use it without re-firing.
  const confirmedRefetch = confirmedQ.refetch;
  const pendingRefetch = pendingQ.refetch;
  const refetch = React.useCallback(() => {
    setNowMs(Date.now());
    return Promise.all([confirmedRefetch(), pendingRefetch()]);
  }, [confirmedRefetch, pendingRefetch]);

  return {
    upcoming,
    isLoading: confirmedQ.isLoading || pendingQ.isLoading,
    isFetching: confirmedQ.isFetching || pendingQ.isFetching,
    isError: confirmedQ.isError || pendingQ.isError,
    error: confirmedQ.error ?? pendingQ.error,
    refetch,
  };
}

export function useAppointment(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.appointment(id) : ["appointment", "skip"],
    queryFn: () => appointmentsApi.byId(id!),
    enabled: Boolean(id),
  });
}

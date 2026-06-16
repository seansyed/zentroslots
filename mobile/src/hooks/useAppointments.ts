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
 * We fetch by STATUS so the page isn't diluted, then selectUpcoming keeps the
 * canonical upcoming set (confirmed + pending + pending_payment) with
 * startAt>=now, sorts ASCENDING, and takes the soonest `count`. The THIRD query
 * (pending_payment) is the fix for the reported bug: a paid-but-unsettled hold
 * is a real appointment (bookings.status enum) that Activity showed but Up Next
 * dropped. (The backend validStatuses now includes pending_payment, so this is a
 * true server-side filter, not a diluted page.)
 *
 * Correct for the realistic tenant scale (a status-filtered page contains all of
 * an SMB's upcoming bookings of that status). Edge: a tenant with >limit FUTURE
 * bookings of one status could have its soonest paged out by the DESC order —
 * the robust fix at that scale is a backend asc/from param (out of scope).
 *
 * `refetchOnMount:"always"` + the Home focus refetch + AppState-foreground
 * invalidation + mutation invalidation keep it fresh after create/confirm/
 * reschedule/cancel/payment-settle.
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
  // pending_payment = a paid service booked but payment not yet settled (a real
  // appointment, ~15-min hold). It belongs in Up Next so operators see it.
  const pendingPaymentQ = useQuery({
    queryKey: queryKeys.appointments({ status: "pending_payment", limit: 100 }),
    queryFn: () => appointmentsApi.list({ status: "pending_payment", limit: 100 }),
    refetchOnMount: "always",
  });

  // `now` advances every time any query gets fresh data. The Home tab stays
  // mounted across tab switches (expo-router Tabs persist), so a frozen mount-
  // time `now` would let a just-passed booking linger. Tying it to dataUpdatedAt
  // means any refresh — pull-to-refresh, AppState-foreground invalidation
  // (useAppLifecycle), a booking/payment mutation invalidation, or the focus
  // refetch — also re-evaluates the >=now cutoff and drops elapsed bookings.
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    setNowMs(Date.now());
  }, [confirmedQ.dataUpdatedAt, pendingQ.dataUpdatedAt, pendingPaymentQ.dataUpdatedAt]);

  const upcoming = React.useMemo<Appointment[]>(() => {
    const rows = [
      ...(confirmedQ.data?.rows ?? []),
      ...(pendingQ.data?.rows ?? []),
      ...(pendingPaymentQ.data?.rows ?? []),
    ];
    return selectUpcoming(rows, nowMs, count);
  }, [confirmedQ.data, pendingQ.data, pendingPaymentQ.data, nowMs, count]);

  // Depend on the (stable) inner refetch fns, not the query objects, so this
  // wrapper is itself stable — a focus effect can use it without re-firing.
  const confirmedRefetch = confirmedQ.refetch;
  const pendingRefetch = pendingQ.refetch;
  const pendingPaymentRefetch = pendingPaymentQ.refetch;
  const refetch = React.useCallback(() => {
    setNowMs(Date.now());
    return Promise.all([confirmedRefetch(), pendingRefetch(), pendingPaymentRefetch()]);
  }, [confirmedRefetch, pendingRefetch, pendingPaymentRefetch]);

  return {
    upcoming,
    isLoading: confirmedQ.isLoading || pendingQ.isLoading || pendingPaymentQ.isLoading,
    isFetching: confirmedQ.isFetching || pendingQ.isFetching || pendingPaymentQ.isFetching,
    isError: confirmedQ.isError || pendingQ.isError || pendingPaymentQ.isError,
    error: confirmedQ.error ?? pendingQ.error ?? pendingPaymentQ.error,
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

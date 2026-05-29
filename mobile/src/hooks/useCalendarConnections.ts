/**
 * useCalendarConnections — read + disconnect provider connections.
 *
 * Refetches on mount because the OAuth round-trip happens in the
 * system browser; when the user comes back into the app a fresh read
 * is the most reliable way to discover "yep, the new connection is
 * live".
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  calendarConnectionsApi,
  type CalendarConnection,
} from "@/api/calendarConnections";
import { queryKeys } from "@/lib/query";
import { track } from "@/lib/telemetry";

export function useCalendarConnections(userId: string | undefined) {
  return useQuery<CalendarConnection[]>({
    queryKey: queryKeys.calendarConnections(userId ?? "anon"),
    queryFn: () => calendarConnectionsApi.list(userId!),
    enabled: Boolean(userId),
    staleTime: 30_000,
    refetchOnMount: "always",
  });
}

export function useDisconnectCalendar(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (connectionId) => calendarConnectionsApi.disconnect(connectionId),
    onSuccess: (_res, connectionId) => {
      track("mutation", "Calendar disconnected", "info", { connectionId });
    },
    onError: (err) => {
      track("mutation", `Calendar disconnect failed: ${err.message}`, "warn");
    },
    onSettled: () => {
      if (userId) {
        void qc.invalidateQueries({
          queryKey: queryKeys.calendarConnections(userId),
        });
      }
      // The /api/auth/me response carries googleConnected — refresh
      // it so the Profile screen reflects the new state.
      void qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

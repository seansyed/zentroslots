/**
 * useSessions — read + revoke active device sessions.
 *
 * The session list comes from the stateless-JWT-derived view the
 * backend builds out of `session_audit_events`. We refetch every 60s
 * on mount so a revoke-from-another-device shows up here within a
 * reasonable beat without spamming the server.
 *
 * Revoke mutations invalidate the cache on settle so the UI reflects
 * the new state without us having to mirror server logic locally.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { sessionsApi, type SessionsResponse } from "@/api/sessions";
import { queryKeys } from "@/lib/query";
import { track } from "@/lib/telemetry";

export function useSessions() {
  return useQuery<SessionsResponse>({
    queryKey: queryKeys.sessions,
    queryFn: () => sessionsApi.list(),
    staleTime: 30_000,
    refetchOnMount: "always",
  });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (jti) => sessionsApi.revoke(jti),
    onSuccess: (_res, jti) => {
      track("mutation", "Session revoked", "info", { jti });
    },
    onError: (err) => {
      track("mutation", `Session revoke failed: ${err.message}`, "warn");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

export function useRevokeAllSessions() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, void>({
    mutationFn: () => sessionsApi.revokeAll(),
    onSuccess: () => {
      track("mutation", "All sessions revoked (except current)", "info");
    },
    onError: (err) => {
      track("mutation", `Revoke-all failed: ${err.message}`, "warn");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

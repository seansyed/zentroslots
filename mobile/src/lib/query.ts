/**
 * TanStack Query client.
 *
 * Single shared instance — mounted in app/_layout.tsx via
 * QueryClientProvider. Defaults tuned for mobile:
 *   - staleTime 30s so we don't refetch on every focus
 *   - cacheTime 5min
 *   - retries 1 (network is flakier on mobile, but we'd rather show a
 *     friendly error than burn the user's data on hidden retries)
 *   - refetchOnWindowFocus disabled (RN has no real window focus and
 *     it interacts badly with screen blur/focus on mobile)
 */

import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { track } from "./telemetry";

/**
 * Global error sinks for both queries and mutations. The screens still
 * render their own ErrorState components — these handlers just feed the
 * telemetry buffer so we can diagnose user-reported issues after the
 * fact ("the screen showed a generic error 3 minutes ago…").
 */
const queryCache = new QueryCache({
  onError: (error, query) => {
    const head = Array.isArray(query.queryKey) ? String(query.queryKey[0]) : "unknown";
    track(
      "network",
      `Query failed: ${head}`,
      "warn",
      {
        queryKey: query.queryKey,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      },
    );
  },
});

const mutationCache = new MutationCache({
  onError: (error, _vars, _ctx, mutation) => {
    const label = mutation.options.mutationKey
      ? String((mutation.options.mutationKey as unknown[])[0])
      : "anonymous";
    track(
      "mutation",
      `Mutation failed: ${label}`,
      "error",
      {
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      },
    );
  },
});

export const queryClient = new QueryClient({
  queryCache,
  mutationCache,
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      gcTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: 0,
    },
  },
});

/** Canonical query-key prefixes. Keep top-level keys discoverable. */
export const queryKeys = {
  me: ["me"] as const,
  /** Business Phone per-user capability (P1.3). */
  phoneMe: ["phoneMe"] as const,
  /** Business Phone recent/missed calls (operators). */
  phoneCalls: (status?: string) =>
    status ? (["phoneCalls", status] as const) : (["phoneCalls"] as const),
  appointments: (params?: Record<string, unknown>) =>
    params ? (["appointments", params] as const) : (["appointments"] as const),
  appointment: (id: string) => ["appointment", id] as const,
  calendar: (range: { from: string; to: string }) => ["calendar", range] as const,
  notifications: ["notifications"] as const,
  customers: (params?: Record<string, unknown>) =>
    params ? (["customers", params] as const) : (["customers"] as const),
  /** Phase 2G — security: active sessions for the current user. */
  sessions: ["sessions"] as const,
  /** Phase 2G — calendar connections for a user (defaults to "self"). */
  calendarConnections: (userId: string) => ["calendarConnections", userId] as const,
  /** Phase 2G — backend health for the diagnostics screen. */
  health: ["health"] as const,
};

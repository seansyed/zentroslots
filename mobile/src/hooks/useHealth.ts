/**
 * useHealth — backend `/api/health` snapshot for the diagnostics screen.
 *
 * staleTime 60s — health doesn't change second-to-second, and we
 * don't want to hammer it on every screen mount. The diagnostics
 * screen exposes a pull-to-refresh that bypasses staleTime when the
 * user explicitly asks.
 */

import { useQuery } from "@tanstack/react-query";

import { healthApi, type HealthResponse } from "@/api/health";
import { queryKeys } from "@/lib/query";

export function useHealth() {
  return useQuery<HealthResponse>({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    staleTime: 60_000,
    refetchOnMount: "always",
    retry: false, // diagnostics expects errors to surface, not be retried silently
  });
}

import { useQuery } from "@tanstack/react-query";

import { phoneApi } from "@/api/phone";
import { queryKeys } from "@/lib/query";

/**
 * Mobile Business Phone status — drives which Phone screen state to render
 * (marketing / setup-pending / active / locked / cap-reached) and whether
 * click-to-call is offered. Safe DTO only; no secrets. Shown to all signed-in
 * users (marketing for the non-entitled), so this is NOT gated behind access.
 */
export function usePhoneStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.phoneStatus,
    queryFn: () => phoneApi.status(),
    staleTime: 60_000,
    enabled,
  });
}

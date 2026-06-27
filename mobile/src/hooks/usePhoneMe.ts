import { useQuery } from "@tanstack/react-query";

import { phoneApi } from "@/api/phone";
import { queryKeys } from "@/lib/query";

/**
 * The calling user's Business Phone capability (masked bridge number + usage).
 * `enabled` lets the screen skip the fetch until we know the user has access.
 */
export function usePhoneMe(enabled = true) {
  return useQuery({
    queryKey: queryKeys.phoneMe,
    queryFn: () => phoneApi.me(),
    staleTime: 60_000,
    enabled,
  });
}

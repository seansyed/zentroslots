import { useQuery } from "@tanstack/react-query";

import { staffApi } from "@/api/staff";

export function useStaff() {
  return useQuery({
    queryKey: ["staff"] as const,
    queryFn: () => staffApi.list(),
    staleTime: 5 * 60_000,
  });
}

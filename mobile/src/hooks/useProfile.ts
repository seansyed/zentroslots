import { useQuery } from "@tanstack/react-query";

import { profileApi } from "@/api/profile";
import { queryKeys } from "@/lib/query";

export function useProfile() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => profileApi.me(),
    staleTime: 5 * 60_000,
  });
}

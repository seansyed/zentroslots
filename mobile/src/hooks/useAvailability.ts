import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  availabilityApi,
  type AvailabilityRule,
  type AvailabilityRuleInput,
} from "@/api/availability";

/**
 * Weekly working-hours hooks.
 *
 * Query key: ["availability", userId ?? "self"]. We key on a stable
 * "self" sentinel when no userId is supplied so the caller's own
 * schedule has a single cache entry regardless of whether the screen
 * passed undefined or later resolved its own id.
 */

function availabilityKey(userId?: string) {
  return ["availability", userId ?? "self"] as const;
}

export function useAvailability(userId?: string) {
  return useQuery<AvailabilityRule[]>({
    queryKey: availabilityKey(userId),
    queryFn: () => availabilityApi.listByUser(userId),
    staleTime: 30_000,
  });
}

/**
 * Bulk-replace a user's weekly schedule. On success we invalidate:
 *   • every availability cache entry (this user's + any staff-picker
 *     selections) via the ["availability"] prefix,
 *   • appointments (booking lists may reflect new bookable windows),
 *   • ["slots"] (New Booking time-slot generation depends on hours),
 * so New Booking reflects the new hours immediately.
 */
export function useSetWeeklySchedule(userId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rules: AvailabilityRuleInput[]) =>
      availabilityApi.setWeeklySchedule(userId, rules),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["availability"] });
      void qc.invalidateQueries({ queryKey: ["appointments"] });
      void qc.invalidateQueries({ queryKey: ["slots"] });
    },
  });
}

/**
 * Locations data hooks — TanStack Query.
 *
 * Mirrors the useCustomers pattern: useQuery for reads, useMutation for
 * writes, invalidate the list (+ specific detail) on success. The detail
 * (`useLocation`) is derived from the same list cache shape via byId, so
 * invalidating `["locations"]` refreshes both surfaces.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  locationsApi,
  type LocationCreateInput,
  type LocationUpdateInput,
} from "@/api/locations";

export function useLocations() {
  return useQuery({
    queryKey: ["locations"] as const,
    queryFn: () => locationsApi.list(),
    staleTime: 30_000,
  });
}

export function useLocation(id: string | undefined) {
  return useQuery({
    queryKey: id ? (["location", id] as const) : (["location", "skip"] as const),
    queryFn: () => locationsApi.byId(id!),
    enabled: Boolean(id),
  });
}

/** Invalidate the list (any params) + a specific location's detail. */
function invalidateLocations(qc: ReturnType<typeof useQueryClient>, id?: string) {
  void qc.invalidateQueries({ queryKey: ["locations"] });
  if (id) void qc.invalidateQueries({ queryKey: ["location", id] });
}

export function useCreateLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LocationCreateInput) => locationsApi.create(input),
    onSuccess: (created) => invalidateLocations(qc, created.id),
  });
}

export function useUpdateLocation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LocationUpdateInput) => locationsApi.update(id, input),
    onSuccess: () => invalidateLocations(qc, id),
  });
}

export function useDeleteLocation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => locationsApi.remove(id),
    onSuccess: () => invalidateLocations(qc, id),
  });
}

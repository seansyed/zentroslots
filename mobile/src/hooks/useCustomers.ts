import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  customersApi,
  type CustomerCreateInput,
  type CustomerUpdateInput,
} from "@/api/customers";
import { queryKeys } from "@/lib/query";

export function useCustomers(params: { q?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.customers(params),
    queryFn: () => customersApi.list(params),
    staleTime: 30_000,
  });
}

export function useCustomer(id: string | undefined) {
  return useQuery({
    queryKey: id ? (["customer", id] as const) : ["customer", "skip"],
    queryFn: () => customersApi.byId(id!),
    enabled: Boolean(id),
  });
}

/** Invalidate every customer list (any search params) + a specific
 *  customer's detail. The list query keys are `["customers", params?]`,
 *  so the `["customers"]` prefix matches them all. */
function invalidateCustomers(qc: ReturnType<typeof useQueryClient>, id?: string) {
  void qc.invalidateQueries({ queryKey: ["customers"] });
  if (id) void qc.invalidateQueries({ queryKey: ["customer", id] });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomerCreateInput) => customersApi.create(input),
    onSuccess: (created) => invalidateCustomers(qc, created.id),
  });
}

export function useUpdateCustomer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomerUpdateInput) => customersApi.update(id, input),
    onSuccess: () => invalidateCustomers(qc, id),
  });
}

/** Archive (soft-delete) — sets status="archived"; preserves history. */
export function useArchiveCustomer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => customersApi.archive(id),
    onSuccess: () => invalidateCustomers(qc, id),
  });
}

export function useUnarchiveCustomer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => customersApi.unarchive(id),
    onSuccess: () => invalidateCustomers(qc, id),
  });
}

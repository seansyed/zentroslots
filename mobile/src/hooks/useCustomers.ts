import { useQuery } from "@tanstack/react-query";

import { customersApi } from "@/api/customers";
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

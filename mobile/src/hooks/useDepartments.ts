/**
 * Department data hooks — TanStack Query.
 *
 * Mirrors the useCustomers pattern: a list query + a create mutation that
 * invalidates the list on success. No update/delete hooks exist because
 * the backend has no /api/departments/[id] route yet (see api/departments.ts).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { departmentsApi, type DepartmentCreateInput } from "@/api/departments";

/** Canonical key prefix. Kept local (not in lib/query) so the module is
 *  self-contained; the `["departments"]` prefix matches all list queries. */
const DEPARTMENTS_KEY = ["departments"] as const;

export function useDepartments() {
  return useQuery({
    queryKey: DEPARTMENTS_KEY,
    queryFn: () => departmentsApi.list(),
    staleTime: 30_000,
  });
}

export function useCreateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DepartmentCreateInput) => departmentsApi.create(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DEPARTMENTS_KEY });
    },
  });
}

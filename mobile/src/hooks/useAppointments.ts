import { useQuery } from "@tanstack/react-query";

import { appointmentsApi, type AppointmentListParams } from "@/api/appointments";
import { queryKeys } from "@/lib/query";

export function useAppointments(params: AppointmentListParams = {}) {
  return useQuery({
    queryKey: queryKeys.appointments(params),
    queryFn: () => appointmentsApi.list(params),
  });
}

export function useAppointment(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.appointment(id) : ["appointment", "skip"],
    queryFn: () => appointmentsApi.byId(id!),
    enabled: Boolean(id),
  });
}

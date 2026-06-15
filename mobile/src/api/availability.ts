/**
 * Availability (weekly working-hours) API client.
 *
 *   GET /api/availability?userId=  — list weekly rules for a user.
 *                                    Omit userId → caller's own schedule.
 *                                    Returns:
 *                                      [{ id, userId, dayOfWeek: 0-6,
 *                                         startTime: "HH:MM", endTime: "HH:MM" }]
 *   PUT /api/availability?userId=  — bulk-replace the ENTIRE weekly
 *                                    schedule for the target user.
 *                                    Body: { rules: [{ dayOfWeek,
 *                                            startTime, endTime }] }
 *
 * Non-self read/write requires the caller to be admin|manager in the
 * same tenant (the backend enforces it via resolveTargetUserId; the
 * mobile UI gates the staff picker for UX only).
 *
 * DST-safety: times are stored + transported as literal "HH:MM" strings.
 * Never derive them from a device-local Date — that would shift hours on
 * DST boundaries. The backend column is a plain time-of-day.
 */

import { apiGet, apiPut } from "./client";

/** dayOfWeek follows the backend convention: 0 = Sunday … 6 = Saturday. */
export type AvailabilityRule = {
  id: string;
  userId: string;
  dayOfWeek: number; // 0-6
  startTime: string; // "HH:MM" (backend may echo "HH:MM:SS")
  endTime: string; // "HH:MM"
};

/** Write payload — only the three fields the PUT schema accepts. The
 *  server assigns id/userId/tenantId itself. */
export type AvailabilityRuleInput = {
  dayOfWeek: number; // 0-6
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
};

export type SetWeeklyScheduleResponse = {
  ok: boolean;
  count: number;
};

/** Normalize a backend time ("HH:MM" or "HH:MM:SS") down to "HH:MM" so
 *  the editor inputs and validation only ever deal with minutes. */
function toHHMM(time: string): string {
  // Defensive: the column is time-of-day; the API has returned both
  // "09:00" and "09:00:00" across migrations. Keep the first two parts.
  const parts = time.split(":");
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
  return time;
}

export const availabilityApi = {
  /** List a user's weekly rules. `userId` undefined → caller's own. */
  async listByUser(userId?: string): Promise<AvailabilityRule[]> {
    const params: Record<string, string> = {};
    if (userId) params.userId = userId;
    const raw = await apiGet<AvailabilityRule[]>("/api/availability", { params });
    const rows = Array.isArray(raw) ? raw : [];
    return rows.map((r) => ({
      ...r,
      startTime: toHHMM(r.startTime),
      endTime: toHHMM(r.endTime),
    }));
  },

  /**
   * Replace the entire weekly schedule for the target user.
   * `userId` undefined → caller's own schedule. An empty `rules` array
   * clears the schedule (user has no working hours).
   */
  async setWeeklySchedule(
    userId: string | undefined,
    rules: AvailabilityRuleInput[],
  ): Promise<SetWeeklyScheduleResponse> {
    const config = userId ? { params: { userId } } : undefined;
    return apiPut<SetWeeklyScheduleResponse, { rules: AvailabilityRuleInput[] }>(
      "/api/availability",
      { rules },
      config,
    );
  },
};

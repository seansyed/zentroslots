/**
 * Calendar endpoints — derived from bookings list for v1.
 *
 * The backend has /api/tenant/calendar-events for custom events and
 * /api/bookings for actual appointments, but no unified day/range
 * calendar endpoint. For v1 we read bookings + treat them as events.
 * When the unified endpoint ships, swap the implementation; the
 * consumer types stay stable.
 */

import { appointmentsApi, type Appointment } from "./appointments";

export type CalendarRange = { from: string; to: string };

export type CalendarEvent = {
  id: string;
  kind: "appointment" | "blocked_time" | "internal_meeting" | "group_session";
  title: string;
  startAt: string;
  endAt: string;
  staffName?: string | null;
  status?: string | null;
  color?: string | null;
};

export type CalendarDay = {
  date: string;
  events: CalendarEvent[];
  totalCount: number;
};

export type CalendarRangeResponse = {
  days: CalendarDay[];
  rangeStart: string;
  rangeEnd: string;
};

function apptToEvent(a: Appointment): CalendarEvent {
  return {
    id: a.id,
    kind: "appointment",
    title: a.serviceName,
    startAt: a.startAt,
    endAt: a.endAt,
    staffName: a.staffName,
    status: a.status,
    color: null,
  };
}

export const calendarApi = {
  async range(range: CalendarRange): Promise<CalendarRangeResponse> {
    const { rows } = await appointmentsApi.list({
      from: range.from,
      to: range.to,
      limit: 200,
    });
    const byDate: Record<string, CalendarEvent[]> = {};
    for (const a of rows) {
      const key = a.startAt.slice(0, 10);
      if (!byDate[key]) byDate[key] = [];
      byDate[key]!.push(apptToEvent(a));
    }
    const days: CalendarDay[] = Object.entries(byDate).map(([date, events]) => ({
      date,
      events,
      totalCount: events.length,
    }));
    return { days, rangeStart: range.from, rangeEnd: range.to };
  },

  async day(date: string): Promise<{ events: CalendarEvent[]; appointments: Appointment[] }> {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const { rows } = await appointmentsApi.list({
      from: dayStart.toISOString(),
      to: dayEnd.toISOString(),
      limit: 100,
    });
    return { events: rows.map(apptToEvent), appointments: rows };
  },
};

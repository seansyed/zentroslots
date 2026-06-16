/**
 * The ONE place mobile turns an appointment instant into a displayed time/day.
 *
 * The backend attaches viewer-timezone labels (startLabel/endLabel/startDayLabel)
 * — the SAME tz rule the web dashboard uses — because Hermes can't reliably
 * format an arbitrary IANA zone on-device (the cause of the 7-hours-early bug
 * when appointments were formatted with device-local getHours()). Mobile renders
 * those labels verbatim and keeps the raw ISO instant for mutations/sorting.
 *
 * When a label is absent (a pre-deploy backend, or an optimistic locally-minted
 * row before refetch) we fall back to the UTC wall-clock slice — deterministic,
 * dependency-free, and NEVER a device-local guess (same philosophy as
 * appointmentsApi.slots' display fallback). For a UTC-tenant viewer the fallback
 * already matches the web; other viewers get the correct label once the labeled
 * response arrives.
 */

export type AppointmentLike = {
  startAt: string;
  endAt?: string | null;
  startLabel?: string | null;
  endLabel?: string | null;
  startDayLabel?: string | null;
};

const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "h:mm a" from the UTC wall-clock of an ISO instant. Fallback only — never
 *  device-local. Returns "" for an unparseable value (fails safe, no crash). */
export function fallbackLabel(iso: string | null | undefined): string {
  if (typeof iso !== "string") return "";
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

/** "Saturday, May 16"-style from the UTC day of an instant (fallback only). */
function fallbackDay(iso: string | null | undefined): string {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // getUTC* is Hermes-safe (only the IANA-tz path is broken).
  return `${WEEKDAYS_SHORT[d.getUTCDay()]}, ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Start time, e.g. "5:00 PM" (server viewer-tz label, else UTC-slice). */
export function apptTime(appt: AppointmentLike): string {
  return (appt.startLabel && appt.startLabel.trim()) || fallbackLabel(appt.startAt);
}

/** End time, e.g. "5:30 PM" (or "" when no end). */
export function apptEndTime(appt: AppointmentLike): string {
  if (appt.endLabel && appt.endLabel.trim()) return appt.endLabel;
  return appt.endAt ? fallbackLabel(appt.endAt) : "";
}

/** "5:00 PM – 5:30 PM" (en-dash), or just the start when no end. */
export function apptTimeRange(appt: AppointmentLike): string {
  const end = apptEndTime(appt);
  return end ? `${apptTime(appt)} – ${end}` : apptTime(appt);
}

/** "Saturday, May 16" in the viewer tz (server label, else UTC-slice day). */
export function apptDay(appt: AppointmentLike): string {
  return (appt.startDayLabel && appt.startDayLabel.trim()) || fallbackDay(appt.startAt);
}

/**
 * Minutes-since-midnight of the start in the VIEWER tz, parsed from the server
 * label (else the UTC-slice fallback). Used by the calendar day-timeline so a
 * booking's vertical POSITION matches its displayed label — both viewer-tz,
 * never device-local. Returns 0 if unparseable (fails safe).
 */
export function apptStartMinutes(appt: AppointmentLike): number {
  const label = (appt.startLabel && appt.startLabel.trim()) || fallbackLabel(appt.startAt);
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(label);
  if (!m) return 0;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3]?.toUpperCase();
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

/** Short weekday + time, e.g. "Sat · 5:00 PM" — for rows showing a non-today date. */
export function apptTimeWithDay(appt: AppointmentLike): string {
  const dayLabel = appt.startDayLabel && appt.startDayLabel.trim()
    ? appt.startDayLabel.split(",")[0]!.slice(0, 3) // "Saturday, May 16" → "Sat"
    : (() => {
        const d = new Date(appt.startAt);
        return Number.isNaN(d.getTime()) ? "" : WEEKDAYS_SHORT[d.getUTCDay()]!;
      })();
  const time = apptTime(appt);
  return dayLabel ? `${dayLabel} · ${time}` : time;
}

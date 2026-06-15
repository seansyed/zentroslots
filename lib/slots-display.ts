import { formatInTimeZone } from "date-fns-tz";

/**
 * Server-authoritative slot display formatting.
 *
 * Each available slot is a UTC instant (ISO-8601). The mobile app must NOT
 * format these on-device: Hermes (RN release) can't reliably format IANA
 * zones, and formatting a UTC instant in the DEVICE timezone is exactly what
 * produced out-of-hours "2:00 AM" slots for 9 AM–6 PM working hours. We format
 * ONCE here, in the authoritative (request/tenant) timezone, and the client
 * renders the label verbatim while booking `start` (the raw instant).
 */
export type SlotDisplay = { start: string; label: string };

/** "h:mm a" (e.g. "9:00 AM") for one instant in the given IANA timezone. */
export function formatSlotLabel(isoInstant: string, timezone: string): string {
  return formatInTimeZone(new Date(isoInstant), timezone, "h:mm a");
}

/** Build the parallel display array for a list of ISO instants. */
export function buildSlotDisplay(slots: string[], timezone: string): SlotDisplay[] {
  return slots.map((iso) => ({ start: iso, label: formatSlotLabel(iso, timezone) }));
}

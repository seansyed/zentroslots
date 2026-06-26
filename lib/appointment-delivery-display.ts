// lib/appointment-delivery-display.ts — pure display helpers for the
// staff/admin appointment detail (phone-appointment work). Framework-free so
// the badge/Call visibility logic is unit-testable without a React/DOM harness.
//
// Contract:
//   • phone   → "Phone Appointment" badge + the phone + a tel: Call action.
//   • custom  → a simple "Custom appointment" label (no phone/Call).
//   • virtual / in_person / null / undefined → NOTHING new — existing display
//     (meetLink card, etc.) is preserved exactly, so old deliveryMode=null
//     bookings look identical to before.

/** A booking's stored delivery mode as the detail API returns it (loose on
 *  purpose — tolerates legacy/unknown strings and null). */
export type DeliveryModeValue =
  | "in_person"
  | "virtual"
  | "phone"
  | "custom"
  | string
  | null
  | undefined;

/** Build a `tel:` href from a human-entered phone, or null when there's no
 *  dialable number. Keeps digits and a single leading "+". */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const sanitized = phone.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return /\d/.test(sanitized) ? `tel:${sanitized}` : null;
}

export type AppointmentDeliveryDisplay = {
  /** Badge text, or null when no badge should render. */
  badgeLabel: string | null;
  /** Phone number to show, or null. Only set for phone appointments. */
  phone: string | null;
  /** tel: href for the Call action, or null. Only set for phone appointments
   *  with a dialable number. */
  callHref: string | null;
};

export function appointmentDeliveryDisplay(
  deliveryMode: DeliveryModeValue,
  clientPhone: string | null | undefined,
): AppointmentDeliveryDisplay {
  if (deliveryMode === "phone") {
    const phone = clientPhone?.trim() ? clientPhone.trim() : null;
    return { badgeLabel: "Phone Appointment", phone, callHref: telHref(phone) };
  }
  if (deliveryMode === "custom") {
    return { badgeLabel: "Custom appointment", phone: null, callHref: null };
  }
  // virtual / in_person / null / undefined / anything else → preserve current UI.
  return { badgeLabel: null, phone: null, callHref: null };
}

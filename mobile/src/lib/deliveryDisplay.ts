// Pure, React-Native-free display helpers for phone appointments on the mobile
// booking-detail screen (phone-appointment work). Mirrors the web helper
// (lib/appointment-delivery-display.ts) but lives in the mobile package — we
// deliberately do NOT import across packages (different bundler/tsconfig).
//
// Contract:
//   • phone   → "Phone Appointment" badge + the phone + a tel: Call action.
//   • custom  → a simple "Custom appointment" label (no phone/Call).
//   • virtual / in_person / null / undefined → NOTHING new — existing display
//     (meeting card, etc.) is preserved, so deliveryMode=null bookings look
//     exactly as before.

export type DeliveryModeValue =
  | "in_person"
  | "virtual"
  | "phone"
  | "custom"
  | string
  | null
  | undefined;

/** Build a `tel:` URL from a human-entered phone, or null when there's no
 *  dialable number. Keeps digits and a single leading "+". */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const sanitized = phone.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return /\d/.test(sanitized) ? `tel:${sanitized}` : null;
}

export type AppointmentDeliveryDisplay = {
  badgeLabel: string | null;
  phone: string | null;
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
  // virtual / in_person / null / undefined / anything else → nothing new.
  return { badgeLabel: null, phone: null, callHref: null };
}

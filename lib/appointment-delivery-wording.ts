// lib/appointment-delivery-wording.ts — pure, shared wording for appointment
// notifications (phone-appointment work). Framework-free + side-effect-free so
// every email template (confirmation / reschedule / cancellation / reminder)
// stays consistent and the branches are unit-testable.
//
// Contract:
//   • phone   → label "Phone Appointment" + a callback line:
//                 - with a number:    "We will call you at <phone>."
//                 - without a number: "This appointment is scheduled by phone."
//   • custom  → label "Custom appointment" (no extra detail).
//   • virtual / in_person / null / undefined → NO wording (preserve existing
//     email behavior exactly; legacy deliveryMode=null bookings are unchanged).
//
// Privacy: callers must pass the CLIENT's callback number (booking.clientPhone /
// the customer's phone) — never a staff/private number.

export type DeliveryModeValue =
  | "in_person"
  | "virtual"
  | "phone"
  | "custom"
  | string
  | null
  | undefined;

export type DeliveryWording = {
  /** Short label, e.g. "Phone Appointment". null = render no delivery wording. */
  label: string | null;
  /** One-line callback detail, or null. */
  detail: string | null;
};

export function appointmentDeliveryWording(
  deliveryMode: DeliveryModeValue,
  clientPhone: string | null | undefined,
): DeliveryWording {
  if (deliveryMode === "phone") {
    const phone = clientPhone?.trim() ? clientPhone.trim() : null;
    return {
      label: "Phone Appointment",
      detail: phone
        ? `We will call you at ${phone}.`
        : "This appointment is scheduled by phone.",
    };
  }
  if (deliveryMode === "custom") {
    return { label: "Custom appointment", detail: null };
  }
  // virtual / in_person / null / undefined / anything else → no new wording.
  return { label: null, detail: null };
}

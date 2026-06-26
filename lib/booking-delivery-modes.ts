// lib/booking-delivery-modes.ts — pure helpers for the public booking flow's
// delivery-mode selector (phone-appointment work). Kept framework-free so the
// selection + submission logic is unit-testable without a React/DOM harness.
//
// Backward-compat contract (mirrors the increment spec):
//   • The selector is only surfaced once a service opts into a NEW client-facing
//     mode (phone/custom) AND offers more than one mode. Legacy services whose
//     modes are a subset of {in_person, virtual} behave EXACTLY as before — no
//     selector, and deliveryMode is omitted from the booking payload entirely.

export const DELIVERY_MODE_ORDER = ["in_person", "virtual", "phone", "custom"] as const;
export type DeliveryMode = (typeof DELIVERY_MODE_ORDER)[number];

// "virtual" is this codebase's term for a video meeting.
export const DELIVERY_MODE_LABEL: Record<DeliveryMode, string> = {
  in_person: "In-person",
  virtual: "Video / Virtual",
  phone: "Phone",
  custom: "Custom",
};

/** Normalize a service's stored delivery_modes into a stable, de-duped,
 *  priority-ordered list, dropping anything unrecognized. */
export function normalizeOfferedModes(
  raw: ReadonlyArray<DeliveryMode | string> | null | undefined,
): DeliveryMode[] {
  const set = new Set(Array.isArray(raw) ? raw : []);
  return DELIVERY_MODE_ORDER.filter((m) => set.has(m));
}

/** Resolve everything the confirm step needs to render the meeting-method UI. */
export function resolveDeliveryModeUI(
  raw: ReadonlyArray<DeliveryMode | string> | null | undefined,
): {
  offeredModes: DeliveryMode[];
  /** True once the service offers a new client-facing mode (phone/custom). */
  involvesNewMode: boolean;
  /** Show the "How would you like to meet?" selector. */
  showModeSelector: boolean;
  /** Initial selected mode: first offered (priority order) when a new mode is
   *  involved; null for legacy services (so deliveryMode is omitted). */
  defaultMode: DeliveryMode | null;
} {
  const offeredModes = normalizeOfferedModes(raw);
  const involvesNewMode = offeredModes.some((m) => m === "phone" || m === "custom");
  const showModeSelector = involvesNewMode && offeredModes.length > 1;
  const defaultMode = involvesNewMode ? offeredModes[0] ?? null : null;
  return { offeredModes, involvesNewMode, showModeSelector, defaultMode };
}

/** Build the delivery fields spread into the booking POST body. Returns an
 *  empty object for legacy services (deliveryMode null) so existing payloads are
 *  byte-identical; includes clientPhone only for a non-empty phone booking. */
export function buildBookingDeliveryPayload(
  deliveryMode: DeliveryMode | null,
  clientPhone: string,
): { deliveryMode?: DeliveryMode; clientPhone?: string } {
  if (!deliveryMode) return {};
  const out: { deliveryMode: DeliveryMode; clientPhone?: string } = { deliveryMode };
  if (deliveryMode === "phone" && clientPhone.trim()) out.clientPhone = clientPhone.trim();
  return out;
}

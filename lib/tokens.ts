import { SignJWT, jwtVerify } from "jose";

const TOKEN_EXPIRY = "30d";

export type BookingTokenKind = "cancel" | "reschedule" | "ics";

export type BookingTokenPayload = {
  bookingId: string;
  tenantId: string;
  kind: BookingTokenKind;
};

function secret(): Uint8Array {
  // Reuse the app's JWT_SECRET. The `purpose: booking_action` claim
  // prevents these tokens from being mistaken for session cookies and
  // vice-versa.
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(s);
}

export async function signBookingToken(payload: BookingTokenPayload): Promise<string> {
  return new SignJWT({ ...payload, purpose: "booking_action" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(secret());
}

export async function verifyBookingToken(
  token: string
): Promise<BookingTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.purpose !== "booking_action") return null;
    if (!payload.bookingId || !payload.tenantId || !payload.kind) return null;
    if (
      payload.kind !== "cancel" &&
      payload.kind !== "reschedule" &&
      payload.kind !== "ics"
    ) {
      return null;
    }
    return {
      bookingId: String(payload.bookingId),
      tenantId: String(payload.tenantId),
      kind: payload.kind,
    };
  } catch {
    return null;
  }
}

/**
 * Helper that builds the absolute URL for a public booking action.
 * Uses APP_BASE_URL so tokens work in emails sent from any env.
 */
export function buildBookingActionUrl(
  token: string,
  action: BookingTokenKind
): string {
  const base = (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
  return `${base}/${action}/${encodeURIComponent(token)}`;
}

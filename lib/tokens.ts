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
 *
 * If APP_BASE_URL is missing in production we'd silently embed
 * `http://localhost:3001` links in customer-facing emails — which
 * means the reschedule/cancel buttons would 404 once they leave the
 * sender's machine. The dev fallback is fine for `npm run dev`, but
 * in production we emit a loud warning so the operator sees it in
 * pm2 logs before customers see broken links. This warning fires
 * AT MOST ONCE per process lifetime — we don't spam the log per
 * email send.
 */
let appBaseUrlWarned = false;
export function buildBookingActionUrl(
  token: string,
  action: BookingTokenKind
): string {
  const configured = process.env.APP_BASE_URL;
  if (!configured && process.env.NODE_ENV === "production" && !appBaseUrlWarned) {
    appBaseUrlWarned = true;
    console.error(
      JSON.stringify({
        evt: "app_base_url_missing",
        severity: "critical",
        ts: new Date().toISOString(),
        impact:
          "Reschedule/cancel email links will point to http://localhost:3001 — set APP_BASE_URL in .env",
      }),
    );
  }
  const base = (configured ?? "http://localhost:3001").replace(/\/+$/, "");
  return `${base}/${action}/${encodeURIComponent(token)}`;
}

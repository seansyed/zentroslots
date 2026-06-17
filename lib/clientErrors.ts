/**
 * Client-side error → friendly message mapper.
 *
 * Why this exists: the backend (lib/auth.ts `errorResponse`) GUARANTEES it
 * never returns raw exception text. Unexpected 500s come back as
 *   { error: "Something went wrong…", code: "internal_error", incidentId }
 * while HttpError / Zod 4xx carry intentional, operator-authored messages.
 *
 * This helper turns a failed fetch (status + parsed body) — or a thrown
 * network error — into a consistent { title, message } pair for toasts and
 * inline alerts, so every screen shows polished, professional copy instead
 * of echoing server strings verbatim. It is defensive-by-default: for 5xx /
 * internal_error it returns generic copy and NEVER surfaces `body.error`,
 * even though the backend already sanitizes it (belt and suspenders).
 *
 * Pure module — no React, no network, no DOM — so it is unit-testable under
 * node:test (see tests/client-errors.test.ts).
 */

export type FriendlyError = { title: string; message: string };

export type ServerErrorBody = {
  error?: unknown;
  code?: unknown;
  incidentId?: unknown;
};

/** Per-screen overrides so a caller can supply context-specific copy. */
export type FriendlyErrorOptions = {
  /** Title for a 409 conflict (default "Time slot unavailable"). */
  conflictTitle?: string;
  /** Message for a 409 conflict. */
  conflictMessage?: string;
  /** Title used for unexpected (5xx / internal) failures. */
  genericTitle?: string;
  /** Message used for unexpected (5xx / internal) failures. */
  genericMessage?: string;
  /** Title used for other handled 4xx with a server-authored message. */
  validationTitle?: string;
};

export const GENERIC_ERROR: FriendlyError = {
  title: "Something went wrong",
  message: "Please try again. If the issue continues, contact support.",
};

export const NETWORK_ERROR: FriendlyError = {
  title: "Connection problem",
  message: "Please check your internet connection and try again.",
};

function safeServerMessage(body?: ServerErrorBody | null): string | null {
  // Only trust a server `error` string when it is NOT the sanitized
  // internal-error envelope and is a sane length (intentional HttpError /
  // Zod copy is short; raw dumps are long or absent).
  if (!body || body.code === "internal_error") return null;
  const e = body.error;
  if (typeof e !== "string") return null;
  const trimmed = e.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return trimmed;
}

/**
 * Map a failed fetch Response (status + parsed JSON body) to friendly copy.
 *
 *  - 409 → "Time slot unavailable" style conflict copy (overridable).
 *  - other 4xx with a safe, server-authored message → show that message
 *    (it is an intentional HttpError/Zod string) under a neutral title.
 *  - 5xx / code=internal_error / anything else → generic copy; the raw
 *    server text is never shown.
 */
export function friendlyError(
  status: number,
  body?: ServerErrorBody | null,
  opts: FriendlyErrorOptions = {},
): FriendlyError {
  if (status === 409) {
    return {
      title: opts.conflictTitle ?? "Time slot unavailable",
      message:
        opts.conflictMessage ??
        safeServerMessage(body) ??
        "This appointment time is no longer available. Please select another time.",
    };
  }

  const serverMsg = safeServerMessage(body);
  if (status >= 400 && status < 500 && serverMsg) {
    return {
      title: opts.validationTitle ?? "Please check the form",
      message: serverMsg,
    };
  }

  // 5xx, internal_error, 0/unknown — never surface server internals.
  return {
    title: opts.genericTitle ?? GENERIC_ERROR.title,
    message: opts.genericMessage ?? GENERIC_ERROR.message,
  };
}

/** Convenience: just the user-facing message string (for single-line alerts). */
export function friendlyMessage(
  status: number,
  body?: ServerErrorBody | null,
  opts: FriendlyErrorOptions = {},
): string {
  return friendlyError(status, body, opts).message;
}

/**
 * Map a thrown error (fetch network failure, JSON parse failure, etc.) to
 * friendly copy. A thrown error means we never got a structured response, so
 * it is almost always connectivity — never expose the raw `Error.message`.
 */
export function friendlyThrown(): FriendlyError {
  return NETWORK_ERROR;
}

/**
 * Deterministic suspicious-login heuristics. No ML.
 *
 * Inputs are the user's prior login fingerprint (lastLoginIp / UA /
 * timestamp) and the current attempt. Output is a closed structured
 * result so the dashboard renders it consistently and we can act on
 * specific signals (e.g. force re-auth on new IP).
 *
 * NEVER blocks login. Marking a login suspicious is purely advisory:
 * we record it, write a security_audit_event, and the dashboard surfaces
 * it. The blocking decision can be added later without changing this
 * module's contract.
 *
 * Pure — never throws.
 */

export type SuspiciousLoginInput = {
  /** Current login attempt. */
  currentIp: string | null;
  currentUserAgent: string | null;
  /** Most recent successful login as recorded on users.last_login_*. */
  priorIp: string | null;
  priorUserAgent: string | null;
  priorLoginAt: Date | null;
};

export type SuspiciousSignal =
  | "first_login_ever"
  | "new_ip"
  | "new_user_agent"
  | "ip_octet_shift"     // /16 changed → likely different network
  | "rapid_revisit"      // < 60s between two logins from different IPs
  | "no_signal";

export type SuspiciousLoginResult = {
  suspicious: boolean;
  signals: SuspiciousSignal[];
  /** Free-form, human-readable reason for the dashboard. */
  summary: string;
};

const RAPID_REVISIT_MS = 60_000;

export function evaluateLoginSuspicion(input: SuspiciousLoginInput): SuspiciousLoginResult {
  const signals: SuspiciousSignal[] = [];

  if (!input.priorLoginAt) {
    signals.push("first_login_ever");
    return {
      suspicious: false, // first login ever isn't suspicious in itself
      signals,
      summary: "First successful login for this account.",
    };
  }

  if (input.currentIp && input.priorIp && input.currentIp !== input.priorIp) {
    signals.push("new_ip");
    // /16 shift = first two IPv4 octets differ → probably a different
    // ISP/network entirely (vs DHCP renewal inside one ISP).
    if (isIpOctetShift(input.priorIp, input.currentIp)) {
      signals.push("ip_octet_shift");
    }
  }

  if (
    input.currentUserAgent &&
    input.priorUserAgent &&
    normalizeUa(input.currentUserAgent) !== normalizeUa(input.priorUserAgent)
  ) {
    signals.push("new_user_agent");
  }

  if (
    input.priorLoginAt &&
    Date.now() - input.priorLoginAt.getTime() < RAPID_REVISIT_MS &&
    signals.includes("new_ip")
  ) {
    signals.push("rapid_revisit");
  }

  if (signals.length === 0) {
    signals.push("no_signal");
    return { suspicious: false, signals, summary: "Login matches prior fingerprint." };
  }

  // Heuristic: suspicious when (a) IP changed AND user-agent changed,
  // OR (b) rapid_revisit fires (always concerning), OR (c) ip_octet_shift
  // fires (new network).
  const ipChanged = signals.includes("new_ip");
  const uaChanged = signals.includes("new_user_agent");
  const suspicious =
    (ipChanged && uaChanged) ||
    signals.includes("rapid_revisit") ||
    signals.includes("ip_octet_shift");

  const summary = suspicious
    ? `Login flagged: ${signals.filter((s) => s !== "no_signal").join(", ")}.`
    : `Minor change in login fingerprint: ${signals.join(", ")}.`;

  return { suspicious, signals, summary };
}

function normalizeUa(ua: string): string {
  // Strip version numbers; the meaningful identity is browser family + OS.
  return ua.replace(/\d+(\.\d+)*/g, "X").toLowerCase().slice(0, 200);
}

function isIpOctetShift(a: string, b: string): boolean {
  const aParts = a.split(".");
  const bParts = b.split(".");
  if (aParts.length !== 4 || bParts.length !== 4) return false;
  // First two octets differ → /16 shift.
  return aParts[0] !== bParts[0] || aParts[1] !== bParts[1];
}

/** Best-effort device label from a user-agent string. Returned as
 *  human-readable, capped at 120 chars to fit the schema column. */
export function deviceLabelFor(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const ua = userAgent;
  let os = "Unknown OS";
  if (/Windows NT 10/.test(ua)) os = "Windows 10/11";
  else if (/Windows NT/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Linux/.test(ua)) os = "Linux";

  let browser = "Unknown browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Chrome\//.test(ua) && !/OPR\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = "Safari";
  else if (/Firefox\//.test(ua)) browser = "Firefox";

  return `${browser} on ${os}`.slice(0, 120);
}

// Pure helpers for the Business Line call-logs API + UI (increment 5):
// query-param parsing/validation, safe-field row shaping (NEVER leaks raw Telnyx
// payloads, signature headers, or internal call-control IDs), and small display
// helpers (status label/tone, duration formatting). No DB, no Telnyx, no React.

export const CALL_LOG_LIMIT_DEFAULT = 25;
export const CALL_LOG_LIMIT_MAX = 100;

// The closed set of call statuses a client may filter by (mirrors CallStatus).
export const CALL_LOG_STATUSES = [
  "ringing",
  "answered",
  "completed",
  "missed",
  "failed",
  "rejected",
  "no_forwarding",
] as const;
export type CallLogStatus = (typeof CALL_LOG_STATUSES)[number];

export const CALL_LOG_DIRECTIONS = ["inbound", "outbound"] as const;

// ─── Query parsing ──────────────────────────────────────────────────────────

export type CallLogQuery = {
  limit: number;
  offset: number;
  status: CallLogStatus | null;
  direction: string | null;
  from: Date | null;
  to: Date | null;
};

export type CallLogQueryResult =
  | { ok: true; query: CallLogQuery }
  | { ok: false; error: string };

type ParamSource = URLSearchParams | Record<string, string | null | undefined>;

function read(params: ParamSource, key: string): string | null {
  if (params instanceof URLSearchParams) return params.get(key);
  const v = params[key];
  return v == null ? null : String(v);
}

/**
 * Parse + validate the call-logs query string. Applies safe defaults
 * (limit 25, offset 0), clamps limit to CALL_LOG_LIMIT_MAX, and rejects
 * malformed values with a typed error rather than silently coercing.
 */
export function parseCallLogQuery(params: ParamSource): CallLogQueryResult {
  // limit
  let limit = CALL_LOG_LIMIT_DEFAULT;
  const rawLimit = read(params, "limit");
  if (rawLimit != null && rawLimit !== "") {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "limit must be a positive integer" };
    limit = Math.min(n, CALL_LOG_LIMIT_MAX);
  }

  // offset
  let offset = 0;
  const rawOffset = read(params, "offset");
  if (rawOffset != null && rawOffset !== "") {
    const n = Number(rawOffset);
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: "offset must be a non-negative integer" };
    offset = n;
  }

  // status filter (empty / "all" → no filter)
  let status: CallLogStatus | null = null;
  const rawStatus = read(params, "status");
  if (rawStatus != null && rawStatus !== "" && rawStatus !== "all") {
    if (!(CALL_LOG_STATUSES as readonly string[]).includes(rawStatus)) {
      return { ok: false, error: "invalid status filter" };
    }
    status = rawStatus as CallLogStatus;
  }

  // direction filter (empty / "all" → no filter)
  let direction: string | null = null;
  const rawDir = read(params, "direction");
  if (rawDir != null && rawDir !== "" && rawDir !== "all") {
    if (!(CALL_LOG_DIRECTIONS as readonly string[]).includes(rawDir)) {
      return { ok: false, error: "invalid direction filter" };
    }
    direction = rawDir;
  }

  // date range (filters on startedAt)
  const rawFrom = read(params, "from");
  const rawTo = read(params, "to");
  const from = parseDate(rawFrom);
  const to = parseDate(rawTo);
  if (rawFrom && !from) return { ok: false, error: "invalid from date" };
  if (rawTo && !to) return { ok: false, error: "invalid to date" };

  return { ok: true, query: { limit, offset, status, direction, from, to } };
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─── Safe row shaping ───────────────────────────────────────────────────────

export type CallLogRowView = {
  id: string;
  fromNumber: string | null;
  toNumber: string | null;
  forwardedToNumber: string | null;
  status: string;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  billableSeconds: number | null;
  costEstimateCents: number | null;
  missed: boolean;
};

/**
 * Project a phone_call_logs row to the SAFE client shape. By construction this
 * returns ONLY the allow-listed fields — internal Telnyx IDs, metadata, raw
 * payloads, and signature headers are never copied out, even if present on the
 * input row.
 */
export function shapeCallLogRow(row: {
  id: string;
  fromNumber?: string | null;
  toNumber?: string | null;
  forwardedToNumber?: string | null;
  status: string;
  startedAt?: Date | string | null;
  answeredAt?: Date | string | null;
  endedAt?: Date | string | null;
  durationSeconds?: number | null;
  billableSeconds?: number | null;
  costEstimateCents?: number | null;
}): CallLogRowView {
  return {
    id: row.id,
    fromNumber: row.fromNumber ?? null,
    toNumber: row.toNumber ?? null,
    forwardedToNumber: row.forwardedToNumber ?? null,
    status: row.status,
    startedAt: toIso(row.startedAt),
    answeredAt: toIso(row.answeredAt),
    endedAt: toIso(row.endedAt),
    durationSeconds: row.durationSeconds ?? null,
    billableSeconds: row.billableSeconds ?? null,
    costEstimateCents: row.costEstimateCents ?? null,
    missed: row.status === "missed" || row.status === "no_forwarding",
  };
}

// ─── Display helpers ────────────────────────────────────────────────────────

export function callStatusLabel(status: string): string {
  switch (status) {
    case "ringing":
      return "Ringing";
    case "answered":
      return "Answered";
    case "completed":
      return "Completed";
    case "missed":
      return "Missed";
    case "failed":
      return "Failed";
    case "rejected":
      return "Rejected";
    case "no_forwarding":
      return "No forwarding";
    default:
      return status;
  }
}

export type CallStatusTone = "green" | "red" | "amber" | "neutral";

export function callStatusTone(status: string): CallStatusTone {
  switch (status) {
    case "completed":
    case "answered":
      return "green";
    case "missed":
    case "no_forwarding":
      return "red";
    case "failed":
    case "rejected":
      return "amber";
    default:
      return "neutral";
  }
}

/** "m:ss" for a call duration, or "—" when there's none. */
export function formatCallDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ─── internals ──────────────────────────────────────────────────────────────

function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : null;
}

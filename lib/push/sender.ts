/**
 * Expo push API client.
 *
 * The Expo Push API accepts up to 100 messages per request:
 *   POST https://exp.host/--/api/v2/push/send
 *   [
 *     { to, title, body, data, sound, badge, channelId, priority, ttl }
 *   ]
 *
 * Response shape:
 *   { data: [{ status: "ok" | "error", id?: <receipt>, message?, details? }] }
 *
 * Important error codes (from `details.error`):
 *   • DeviceNotRegistered      — token is dead, drop it
 *   • MessageTooBig            — drop the message
 *   • MessageRateExceeded      — back off + retry
 *   • InvalidCredentials       — server config; alert + drop
 *
 * 5xx + network errors → transient, schedule retry with backoff.
 *
 * Send + classify is `sendExpoPushBatch`. Receipt-fetching (step 2 of the
 * Expo flow) is `fetchExpoPushReceipts` — a 'sent' ticket is only a HANDOFF
 * to Expo; the receipt is the authoritative delivery result and is where
 * DeviceNotRegistered surfaces for tokens that died after registration.
 * scripts/process-push-receipts.ts polls receipts and prunes dead tokens.
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const MAX_BATCH = 100;
const MAX_RECEIPT_BATCH = 1000; // Expo accepts up to 1000 receipt ids per request
// Hard ceiling so a single batch can't burn the worker — Expo accepts
// 100 messages per request, we'll go up to that.

export type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  badge?: number;
  channelId?: string;
  priority?: "default" | "normal" | "high";
  ttl?: number;
  /** Per-message identifier we set so we can correlate receipts back. */
  _id?: string;
};

export type ExpoTicketResult =
  | { _id?: string; status: "ok"; receiptId: string | null }
  | {
      _id?: string;
      status: "error";
      message: string;
      errorCode: string | null;
      /** True if the error is permanent and the token should be deleted. */
      tokenInvalid: boolean;
      /** True if the error is transient and a retry will likely succeed. */
      transient: boolean;
    };

type ExpoTicket = {
  status?: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
};

const PERMANENT_TOKEN_ERRORS = new Set([
  "DeviceNotRegistered",
  "InvalidCredentials",
]);
const TRANSIENT_ERRORS = new Set([
  "MessageRateExceeded",
]);

/**
 * Send a batch of Expo push messages. Splits oversize input into
 * 100-message chunks. Returns one result per input message in the
 * same order, so callers can map back to their delivery rows.
 *
 * NEVER throws — network/parse errors return as `status: "error"` with
 * `transient: true` so the worker schedules a retry.
 */
export async function sendExpoPushBatch(
  messages: ExpoPushMessage[],
): Promise<ExpoTicketResult[]> {
  const results: ExpoTicketResult[] = new Array(messages.length);

  for (let i = 0; i < messages.length; i += MAX_BATCH) {
    const slice = messages.slice(i, i + MAX_BATCH);
    let tickets: ExpoTicket[] | null = null;
    let networkError: string | null = null;

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(slice.map((m) => ({ ...m, _id: undefined }))),
      });

      if (!res.ok) {
        networkError = `Expo HTTP ${res.status}`;
      } else {
        const json = (await res.json()) as { data?: ExpoTicket[]; errors?: unknown };
        tickets = Array.isArray(json.data) ? json.data : null;
        if (!tickets) {
          networkError = "Expo returned unexpected payload";
        }
      }
    } catch (err) {
      networkError = err instanceof Error ? err.message : "Unknown send error";
    }

    for (let j = 0; j < slice.length; j++) {
      const idx = i + j;
      const original = slice[j]!;
      if (networkError || !tickets) {
        results[idx] = {
          _id: original._id,
          status: "error",
          message: networkError ?? "No ticket returned",
          errorCode: null,
          tokenInvalid: false,
          transient: true,
        };
        continue;
      }
      const t = tickets[j];
      if (!t) {
        results[idx] = {
          _id: original._id,
          status: "error",
          message: "Missing ticket",
          errorCode: null,
          tokenInvalid: false,
          transient: true,
        };
        continue;
      }
      if (t.status === "ok") {
        results[idx] = {
          _id: original._id,
          status: "ok",
          receiptId: t.id ?? null,
        };
      } else {
        const code = t.details?.error ?? null;
        results[idx] = {
          _id: original._id,
          status: "error",
          message: t.message ?? code ?? "Expo error",
          errorCode: code,
          tokenInvalid: code ? PERMANENT_TOKEN_ERRORS.has(code) : false,
          transient: code ? TRANSIENT_ERRORS.has(code) : false,
        };
      }
    }
  }

  return results;
}

// ─── Receipt fetching (step 2 of the Expo flow) ────────────────────────

export type ExpoReceiptResult =
  /** Expo confirmed delivery to the provider (FCM/APNs). */
  | { status: "ok" }
  /** A receipt error. tokenInvalid → delete the token; transient → re-check. */
  | { status: "error"; message: string; errorCode: string | null; tokenInvalid: boolean; transient: boolean }
  /** Receipt not yet available (Expo omits it) — re-check next tick. */
  | { status: "pending" };

type ExpoReceipt = {
  status?: "ok" | "error";
  message?: string;
  details?: { error?: string };
};

/**
 * Fetch Expo delivery receipts for a set of receipt ids. Returns a map keyed
 * by receipt id. Ids that are NOT present in Expo's response are returned as
 * `{ status: "pending" }` (still processing). NEVER throws — on network/5xx
 * the whole requested chunk is returned as transient errors so the caller
 * re-checks rather than dropping tokens.
 */
export async function fetchExpoPushReceipts(
  receiptIds: string[],
): Promise<Record<string, ExpoReceiptResult>> {
  const out: Record<string, ExpoReceiptResult> = {};

  for (let i = 0; i < receiptIds.length; i += MAX_RECEIPT_BATCH) {
    const chunk = receiptIds.slice(i, i + MAX_RECEIPT_BATCH);
    let data: Record<string, ExpoReceipt> | null = null;
    let networkError: string | null = null;

    try {
      const res = await fetch(EXPO_RECEIPTS_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids: chunk }),
      });
      if (!res.ok) {
        networkError = `Expo HTTP ${res.status}`;
      } else {
        const json = (await res.json()) as { data?: Record<string, ExpoReceipt> };
        data = json.data && typeof json.data === "object" ? json.data : null;
        if (!data) networkError = "Expo returned unexpected receipts payload";
      }
    } catch (err) {
      networkError = err instanceof Error ? err.message : "Unknown receipts error";
    }

    for (const id of chunk) {
      if (networkError || !data) {
        // Transient — re-check next tick; do NOT delete the token.
        out[id] = { status: "error", message: networkError ?? "no data", errorCode: null, tokenInvalid: false, transient: true };
        continue;
      }
      const r = data[id];
      if (!r) {
        out[id] = { status: "pending" }; // not ready yet
      } else if (r.status === "ok") {
        out[id] = { status: "ok" };
      } else {
        const code = r.details?.error ?? null;
        out[id] = {
          status: "error",
          message: r.message ?? code ?? "Expo receipt error",
          errorCode: code,
          tokenInvalid: code ? PERMANENT_TOKEN_ERRORS.has(code) : false,
          transient: code ? TRANSIENT_ERRORS.has(code) : false,
        };
      }
    }
  }

  return out;
}

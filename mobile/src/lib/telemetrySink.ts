/**
 * telemetrySink — batched remote flush for the in-app telemetry buffer.
 *
 * Architecture:
 *   • The buffer in src/lib/telemetry.ts is the canonical source of truth.
 *     This module reads from it, never writes.
 *   • A watermark `sentUpTo` (ms timestamp) is persisted to AsyncStorage so
 *     we never re-send an event that already made it home.
 *   • Flushes batch up to 80 events per request (headroom under the
 *     server's 100-event cap). If the buffer is bigger than 80 unsent
 *     events, the older 80 ship now and the rest ship next tick.
 *   • Triggers: a 60s interval + AppState transitions to background. The
 *     background trigger is the important one — operators usually look
 *     at the app, then close it. Without it we'd miss the events that
 *     accumulated during the foreground session.
 *
 * Safety:
 *   • Every network call is try/catch wrapped. A telemetry POST that
 *     fails MUST NOT surface to the user.
 *   • If the request fails, we DO NOT advance `sentUpTo` — the events
 *     get retried on the next tick.
 *   • Auth-optional. The backend route accepts both authed and
 *     anonymous batches; we send whatever cookies/headers axios has.
 *
 * Hooked from app/_layout.tsx via `startTelemetrySink()`.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Platform, type AppStateStatus } from "react-native";

import { apiPost } from "@/api/client";
import { env } from "@/lib/env";
import { getBuffer, type TelemetryEvent } from "@/lib/telemetry";

const WATERMARK_KEY = "zentromeet:telemetry:sentUpTo:v1";
const DEVICE_ID_KEY = "zentromeet:telemetry:deviceId:v1";
const MAX_BATCH = 80;
const FLUSH_INTERVAL_MS = 60_000;

/**
 * Circuit breaker — after this many consecutive failures we cool down
 * the flush interval to {@link COOLDOWN_INTERVAL_MS} until ONE success
 * resets the counter. Prevents the flusher from burning the user's
 * battery on a long backend outage (we'd rather lose granularity on
 * crash trails than ruin battery life during incidents).
 */
const FAILURE_THRESHOLD = 5;
const COOLDOWN_INTERVAL_MS = 300_000; // 5 minutes

let watermark = 0;
let deviceId: string | null = null;
let flushing = false;
let timer: ReturnType<typeof setInterval> | null = null;
let appStateSub: { remove: () => void } | null = null;
let consecutiveFailures = 0;
let lastFlushAt = 0;

function newDeviceId(): string {
  // Cheap UUID-ish — not crypto-grade, but the backend only uses it
  // for de-duping events from the same crashing install.
  return (
    "d-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

async function loadWatermark(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(WATERMARK_KEY);
    const n = raw ? Number(raw) : 0;
    if (Number.isFinite(n) && n > 0) watermark = n;
  } catch {
    // Storage unavailable — start fresh.
  }
  try {
    const raw = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (raw && raw.length > 0) {
      deviceId = raw;
    } else {
      deviceId = newDeviceId();
      AsyncStorage.setItem(DEVICE_ID_KEY, deviceId).catch(() => {});
    }
  } catch {
    deviceId = newDeviceId(); // ephemeral fallback
  }
}

async function saveWatermark(ts: number): Promise<void> {
  watermark = ts;
  try {
    await AsyncStorage.setItem(WATERMARK_KEY, String(ts));
  } catch {
    // Storage unavailable — fine, we'll re-persist next flush.
  }
}

/**
 * Flush pending events to the backend. Idempotent — safe to call from
 * the interval, AppState handler, or sign-out path.
 *
 * Includes a circuit-breaker: when {@link consecutiveFailures} exceeds
 * the threshold, we honour a cooldown so we don't beat on a dead
 * backend every 60 seconds. The cooldown resets the instant ONE flush
 * succeeds.
 */
export async function flushTelemetry(): Promise<void> {
  if (flushing) return;

  // Circuit breaker: if we've failed N times in a row, only flush
  // every COOLDOWN_INTERVAL_MS instead of the normal cadence.
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    const sinceLast = Date.now() - lastFlushAt;
    if (sinceLast < COOLDOWN_INTERVAL_MS) return;
  }

  flushing = true;
  lastFlushAt = Date.now();
  try {
    const all = getBuffer();
    // Everything newer than the watermark is unsent.
    const pending: TelemetryEvent[] = [];
    for (const e of all) {
      if (e.ts > watermark) pending.push(e);
      if (pending.length >= MAX_BATCH) break;
    }
    if (pending.length === 0) {
      // Nothing to send — don't count this as a failure, but don't
      // touch the breaker either (an empty buffer isn't a signal that
      // the backend is back).
      return;
    }

    await apiPost<{ ok: boolean; received: number }>(
      "/api/mobile/telemetry",
      {
        appVersion: env.appVersion,
        platform: Platform.OS,
        deviceId,
        events: pending,
      },
    );
    // Advance the watermark to the latest ts we just shipped. Use the
    // max of the batch in case events arrived out of order (they
    // shouldn't, but defence in depth).
    const maxTs = pending.reduce((m, e) => (e.ts > m ? e.ts : m), 0);
    if (maxTs > watermark) await saveWatermark(maxTs);
    // Success — reset the breaker.
    consecutiveFailures = 0;
  } catch {
    // Network failure or 4xx — we'll retry next tick. Don't surface to
    // the user; telemetry must never disrupt the operator.
    consecutiveFailures = Math.min(consecutiveFailures + 1, FAILURE_THRESHOLD + 1);
  } finally {
    flushing = false;
  }
}

function handleAppState(state: AppStateStatus): void {
  // Flush on the way out — operators close apps, we want their crumbs
  // to ship before they walk away. We also flush on "inactive" to
  // cover iOS app-switcher peeks; on Android only "background" fires.
  if (state === "background" || state === "inactive") {
    void flushTelemetry();
  }
}

/**
 * Boot the sink. Idempotent: calling it more than once is a no-op.
 * Called from app/_layout.tsx after auth hydration.
 *
 * Returns a teardown function for hot-reload + tests.
 */
export function startTelemetrySink(): () => void {
  // Re-entry guard: if a previous sink is still alive, dispose first.
  if (timer || appStateSub) {
    return () => {};
  }

  // Fire-and-forget hydration — the first flush waits for the
  // interval anyway, so blocking on disk read is wasted.
  void loadWatermark();

  timer = setInterval(() => {
    void flushTelemetry();
  }, FLUSH_INTERVAL_MS);

  appStateSub = AppState.addEventListener("change", handleAppState);

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (appStateSub) {
      appStateSub.remove();
      appStateSub = null;
    }
  };
}

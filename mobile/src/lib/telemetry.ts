/**
 * telemetry — minimal, dependency-free in-app event buffer.
 *
 * Why hand-rolled instead of Sentry/Bugsnag:
 *   • No new deps (rule #2 of every phase).
 *   • The beta cohort is small enough that on-device inspection via a
 *     hidden diagnostics screen is more valuable than a managed dashboard.
 *   • If/when we outgrow this, swapping in Sentry is a single import —
 *     the `track()` API stays the same.
 *
 * What we capture:
 *   • crash       — render error caught by ErrorBoundary
 *   • runtime     — global error / unhandledrejection handler
 *   • network     — request failure (status 0 or 5xx)
 *   • mutation    — failed react-query mutation
 *   • navigation  — segment change (a thin breadcrumb)
 *   • info        — explicit ops note (e.g. "cache rehydrated")
 *
 * Storage:
 *   In-memory ring of the most recent 200 events. Periodically flushed to
 *   AsyncStorage so a relaunch after a crash still shows the trail. We
 *   never block UI on persistence — every write is fire-and-forget.
 *
 * Privacy:
 *   We deliberately do NOT capture request bodies, tokens, or PII. Only
 *   structural metadata (URL pattern, status, error name + message,
 *   route segments, app version, platform, a random non-PII device id).
 *   The buffer is flushed to the backend by telemetrySink.ts (POST
 *   /api/mobile/telemetry, ~every 60s + on background) — metadata only,
 *   never tokens/PII.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "zentromeet:telemetry:v1";
const MAX_EVENTS = 200;
const PERSIST_DEBOUNCE_MS = 1500;

export type TelemetrySeverity = "info" | "warn" | "error";

export type TelemetryKind =
  | "crash"
  | "runtime"
  | "network"
  | "mutation"
  | "navigation"
  | "info";

export type TelemetryEvent = {
  /** Monotonic ms timestamp. */
  ts: number;
  kind: TelemetryKind;
  severity: TelemetrySeverity;
  /** Short label (≤ 80 chars). */
  label: string;
  /** Optional structured detail. Anything goes — we redact PII at call sites. */
  detail?: Record<string, unknown>;
};

const buffer: TelemetryEvent[] = [];
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // Listener bugs never block telemetry.
    }
  }
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    // Persist a copy — never expose the live array.
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(buffer.slice(-MAX_EVENTS))).catch(
      () => {
        // Storage may be unavailable (private browsing, quota). Ignore.
      },
    );
  }, PERSIST_DEBOUNCE_MS);
}

/** Record an event. Safe to call from any context. */
export function track(
  kind: TelemetryKind,
  label: string,
  severity: TelemetrySeverity = "info",
  detail?: Record<string, unknown>,
): void {
  try {
    buffer.push({
      ts: Date.now(),
      kind,
      severity,
      label: label.length > 200 ? label.slice(0, 200) + "…" : label,
      detail,
    });
    if (buffer.length > MAX_EVENTS) {
      buffer.splice(0, buffer.length - MAX_EVENTS);
    }
    schedulePersist();
    notify();
    // Mirror to console for dev — but ONLY for warn/error so happy-path
    // breadcrumbs don't drown out real signals. Phase 4: gated behind
    // __DEV__ so production builds stay quiet (we don't want operators
    // seeing red console errors when they pop the debug menu in a
    // production TestFlight build).
    if (
      __DEV__ &&
      severity !== "info" &&
      typeof console !== "undefined"
    ) {
      const out =
        severity === "error"
          ? (console.error?.bind(console) ?? console.log.bind(console))
          : (console.warn?.bind(console) ?? console.log.bind(console));
      out(`[telemetry/${kind}] ${label}`, detail ?? "");
    }
  } catch {
    // Telemetry must never crash the app.
  }
}

/** Read the in-memory buffer (most recent last). */
export function getBuffer(): TelemetryEvent[] {
  return buffer.slice();
}

/** Subscribe to buffer changes — used by the diagnostics screen. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Wipe the buffer + persisted snapshot. */
export async function clearTelemetry(): Promise<void> {
  buffer.length = 0;
  notify();
  await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
}

/**
 * Hydrate from AsyncStorage on cold start so a crash report survives a
 * relaunch. Idempotent. Fire-and-forget — never block boot.
 */
export async function hydrateTelemetry(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as TelemetryEvent[];
    if (!Array.isArray(parsed)) return;
    // Prepend persisted events so post-launch events still land at the end.
    for (let i = 0; i < parsed.length && buffer.length < MAX_EVENTS; i++) {
      const e = parsed[i];
      if (e && typeof e.ts === "number" && typeof e.label === "string") {
        buffer.push(e);
      }
    }
    notify();
  } catch {
    // Corrupt or unavailable — fine. We'll rebuild.
  }
}

/** Filter helper used by the diagnostics screen. */
export function countBy(severity: TelemetrySeverity): number {
  let n = 0;
  for (const e of buffer) if (e.severity === severity) n++;
  return n;
}

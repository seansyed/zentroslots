/**
 * pushDiagnostics — in-memory push-registration health snapshot.
 *
 * Code-only observability for the Expo push pipeline. The push hook
 * (usePushNotifications) records each registration STAGE here as it runs;
 * the diagnostics screen (/settings/diagnostics) renders the snapshot so an
 * operator can see — WITHOUT adb logcat — exactly where push registration
 * stopped:
 *
 *   permission → token (getExpoPushTokenAsync) → upload (POST) → ready
 *
 * This was built after the confirmed Android root cause: the build had no
 * Firebase/FCM config, so getExpoPushTokenAsync() threw and a bare
 * `catch { return null }` hid it — producing push_tokens=0 with zero
 * visible signal. `classifyTokenError` recognizes that exact signature.
 *
 * Dependency-free ON PURPOSE — no React Native / Expo imports — so it stays
 * unit-testable under node:test and can never contribute to a boot crash.
 */

export type PushStage = "idle" | "permission" | "token" | "upload" | "ready" | "failed";

export type PushDiagnostics = {
  /** Last update (ms epoch), or null if never recorded this session. */
  updatedAt: number | null;
  /** Where the pipeline currently is, or the stage it stopped at. */
  stage: PushStage;
  /** OS notification permission. null = not yet checked. */
  permissionGranted: boolean | null;
  /**
   * Whether the native Firebase/FCM layer initialized. Inferred from the
   * getExpoPushTokenAsync outcome: true on success; false when the error
   * matches the "FirebaseApp not initialized / google-services not applied"
   * signature; null when it can't be determined (transient/unknown).
   */
  firebaseAvailable: boolean | null;
  /** Expo push token obtained from getExpoPushTokenAsync. */
  tokenObtained: boolean;
  /** Token successfully POSTed to the backend (/api/mobile/push-tokens). */
  tokenUploaded: boolean;
  /** End-to-end readiness: token obtained AND uploaded. */
  pushAvailable: boolean;
  /** EAS projectId passed to getExpoPushTokenAsync (null if unresolved). */
  projectId: string | null;
  /** Redacted, truncated last error message. */
  lastError: string | null;
  /** Stage at which lastError occurred. */
  lastErrorStage: PushStage | null;
};

export const INITIAL_PUSH_DIAGNOSTICS: PushDiagnostics = {
  updatedAt: null,
  stage: "idle",
  permissionGranted: null,
  firebaseAvailable: null,
  tokenObtained: false,
  tokenUploaded: false,
  pushAvailable: false,
  projectId: null,
  lastError: null,
  lastErrorStage: null,
};

let current: PushDiagnostics = { ...INITIAL_PUSH_DIAGNOSTICS };
const listeners = new Set<() => void>();

/** Current snapshot (referentially stable until the next record). */
export function getPushDiagnostics(): PushDiagnostics {
  return current;
}

/** Subscribe to snapshot changes (the diagnostics screen re-renders on these). */
export function subscribePushDiagnostics(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Merge a partial update into the snapshot, stamp the time, notify listeners. */
export function recordPushDiagnostic(patch: Partial<PushDiagnostics>): PushDiagnostics {
  current = { ...current, ...patch, updatedAt: Date.now() };
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* a listener bug must never break diagnostics */
    }
  }
  return current;
}

/** Flatten + truncate any thrown value to a safe one-line string. */
export function errorMessage(err: unknown): string {
  let raw: string;
  if (err instanceof Error) raw = err.message || err.name;
  else if (typeof err === "string") raw = err;
  else {
    try {
      raw = JSON.stringify(err);
    } catch {
      raw = String(err);
    }
  }
  return (raw || "unknown error").replace(/\s+/g, " ").trim().slice(0, 300);
}

// The unmistakable "Firebase/FCM not configured in this build" signature
// (the confirmed Android root cause). Matched case-insensitively.
const FIREBASE_NOT_CONFIGURED = [
  "default firebaseapp",
  "firebaseapp is not initialized",
  "firebaseapp failed to initialize",
  "no default options were found",
  "google-services", // "com.google.gms:google-services was not applied"
  "firebaseapp initialization unsuccessful",
];
// FCM transport faults that also mean a push token can't be obtained.
const FCM_UNAVAILABLE = ["service_not_available", "missing_instanceid_service", "fis_auth_error"];

/**
 * Classify a getExpoPushTokenAsync failure.
 *   firebaseAvailable=false  → unmistakable Firebase/FCM-not-configured signature.
 *   firebaseAvailable=null   → could be transient/network/projectId; do NOT assert.
 */
export function classifyTokenError(err: unknown): {
  firebaseAvailable: boolean | null;
  reason: string;
} {
  const msg = errorMessage(err).toLowerCase();
  if (FIREBASE_NOT_CONFIGURED.some((p) => msg.includes(p))) {
    return { firebaseAvailable: false, reason: "firebase_not_configured" };
  }
  if (FCM_UNAVAILABLE.some((p) => msg.includes(p))) {
    return { firebaseAvailable: false, reason: "fcm_unavailable" };
  }
  return { firebaseAvailable: null, reason: "unknown" };
}

/** One-line human summary for the diagnostics UI / copied logs. */
export function summarizePush(d: PushDiagnostics): string {
  if (d.pushAvailable) return "Push ready";
  if (d.stage === "idle") return "Not started";
  if (d.firebaseAvailable === false) return "Blocked: Firebase/FCM not configured in this build";
  if (d.permissionGranted === false) return "Blocked: notifications permission not granted";
  if (d.stage === "failed" && d.lastErrorStage === "upload") return "Token obtained but upload failed";
  if (d.stage === "failed") return `Failed at ${d.lastErrorStage ?? d.stage}`;
  return `In progress (${d.stage})`;
}

/** Test-only reset. */
export function __resetPushDiagnostics(): void {
  current = { ...INITIAL_PUSH_DIAGNOSTICS };
  listeners.clear();
}

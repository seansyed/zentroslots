/**
 * Boot-safety primitives — PURE (no React, no native, no Expo imports) so
 * they are unit-testable under plain node and can never themselves fail to
 * load on the boot path.
 *
 * These exist because an optional subsystem (push notifications, telemetry)
 * must never be able to white-screen the app: any failure has to be
 * contained and reported, not thrown out to bundle evaluation / render.
 */

/**
 * Wrap a side-effecting initializer so it:
 *   - runs at most once on success (idempotent across re-renders / cold
 *     starts within a session),
 *   - never throws (fail-open) — a thrown error is routed to `onError`,
 *   - can be retried: a FAILED run is not marked done, so calling the
 *     returned function again will attempt the init once more (this is what
 *     makes a "Retry" path actually re-run initialization).
 *
 * Returns the wrapped function, which returns `true` when the init has
 * succeeded (now or earlier) and `false` when this attempt failed.
 */
export function createRunOnceSafe(
  fn: () => void,
  onError?: (e: unknown) => void,
): () => boolean {
  let done = false;
  return () => {
    if (done) return true;
    try {
      fn();
      done = true;
      return true;
    } catch (e) {
      // Fail-open + report. The reporter itself must never throw on the
      // boot path, so it is guarded too.
      try {
        onError?.(e);
      } catch {
        /* swallow reporter failures */
      }
      return false;
    }
  };
}

/**
 * Run a boot-path side effect, contain any throw, and report it BY NAME.
 *
 * Why this exists: React commits a component's passive effects (useEffect
 * bodies) in a single pass. If ANY effect throws synchronously, React aborts
 * the pass and unwinds to the nearest error boundary, which UNMOUNTS the
 * subtree. On our boot path that unmount runs the cleanup of the splash-
 * dismiss timer (`clearTimeout`), so the native splash never hides and the
 * app freezes on the launch screen (observed on device as the "Z" splash +
 * an ANR). A single undefined native call in an optional listener-attach
 * (deep links, app-state, notifications) was enough to do this.
 *
 * Wrapping each boot effect's body in `guard()` means a failure is contained
 * (the tree is never unmounted, so the app still reaches the login screen)
 * AND named: the error is logged with a stable, greppable `[boot:<label>]`
 * prefix that shows up as `E ReactNativeJS` in `adb logcat` even in a release
 * build — so the exact failing step is identified without a symbolicated map.
 *
 * Returns whatever `fn` returns, or `fallback` (default `undefined`) on throw.
 */
export function guard<T>(label: string, fn: () => T, fallback?: T): T | undefined {
  try {
    return fn();
  } catch (e) {
    try {
      const err = e as { message?: unknown; stack?: unknown };
      // eslint-disable-next-line no-console
      console.error(
        `[boot:${label}] failed: ${String(err?.message ?? e)}`,
        typeof err?.stack === "string" ? err.stack.split("\n").slice(0, 6).join("\n") : "",
      );
    } catch {
      /* logging must never throw on the boot path */
    }
    return fallback;
  }
}

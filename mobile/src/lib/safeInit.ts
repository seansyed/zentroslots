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

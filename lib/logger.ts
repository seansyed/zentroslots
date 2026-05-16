/**
 * Lightweight structured JSON logger + request timing wrapper.
 *
 * Why not pino/winston? Both are great; this project favors zero deps.
 * The output format is intentionally JSON-per-line so any log aggregator
 * (Logtail, Datadog, Loki, Sentry, CloudWatch) can ingest it as-is.
 *
 * Sentry adapter is opt-in via SENTRY_DSN — if absent, log.error is a
 * plain console call. No tight coupling.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

let sentry: { captureException: (e: unknown, ctx?: Fields) => void } | null = null;
let sentryInitTried = false;

async function maybeSentry() {
  if (sentryInitTried) return;
  sentryInitTried = true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    // Dynamic import: only loaded if a DSN is configured. Avoids pulling
    // the SDK into bundles for tenants who don't use Sentry.
    const mod = (await import("@sentry/node").catch(() => null)) as
      | { init: (o: { dsn: string }) => void; captureException: (e: unknown, ctx?: Fields) => void }
      | null;
    if (!mod) return;
    mod.init({ dsn });
    sentry = { captureException: mod.captureException.bind(mod) };
  } catch {
    /* swallow — we never want logger init to crash boot */
  }
}

function emit(level: LogLevel, message: string, fields?: Fields) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    lvl: level,
    msg: message,
    ...(fields ?? {}),
  });
  // Use console.* so the runtime's default log pipeline handles it.
  switch (level) {
    case "debug": console.debug(line); break;
    case "info":  console.log(line); break;
    case "warn":  console.warn(line); break;
    case "error": console.error(line); break;
  }
}

export const log = {
  debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
  info:  (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn:  (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, err?: unknown, fields?: Fields) => {
    const errObj = err instanceof Error
      ? { name: err.name, message: err.message, stack: err.stack }
      : err !== undefined ? { value: err } : undefined;
    emit("error", msg, { ...(fields ?? {}), err: errObj });
    if (err !== undefined) {
      maybeSentry().then(() => sentry?.captureException(err, fields));
    }
  },
};

/**
 * Wraps an async handler with request timing. Use sparingly — usually
 * the routing layer already times things; this is for hot paths you
 * want explicit numbers on.
 *
 *   const result = await time("getAvailableSlots", () => engine.run(...));
 */
export async function time<T>(label: string, fn: () => Promise<T>, fields?: Fields): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    log.info(`${label}:ok`, { ms: Date.now() - start, ...(fields ?? {}) });
    return result;
  } catch (err) {
    log.error(`${label}:err`, err, { ms: Date.now() - start, ...(fields ?? {}) });
    throw err;
  }
}

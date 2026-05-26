/**
 * Stabilization Wave — structured logger.
 *
 * Drop-in replacement for ad-hoc console.log / console.error calls in
 * server-side code. Emits one-line JSON to stdout/stderr so log
 * aggregators (CloudWatch, Datadog, Grafana Loki) can parse them
 * without regex.
 *
 *   import { log } from "@/lib/log";
 *   log.info("booking.created", { tenantId, bookingId });
 *   log.error("stripe.webhook_failed", { eventId, reason });
 *
 * Why not pino / winston?
 *   • These would add a transitive dep + tunneling concerns on the
 *     edge runtime. We need a 30-line solution, not a framework.
 *   • The existing code already uses JSON.stringify({ evt, ...rest })
 *     patterns; this wrapper normalizes them.
 *
 * Correlation IDs:
 *   The Next.js middleware injects x-request-id on every request.
 *   API routes pass it through via `withRequestId(req, ...)`. The
 *   resulting log lines carry req_id automatically.
 *
 * Never throws. A logger that breaks during an error path is a
 * second outage.
 */

import { AsyncLocalStorage } from "node:async_hooks";

type LogLevel = "debug" | "info" | "warn" | "error";

type Context = {
  reqId?: string;
  /** Tenant context — never log raw secrets / PII; tenantId is OK. */
  tenantId?: string;
  /** User context — userId is OK; email is OK; password etc never. */
  userId?: string;
  /** Free-form module name for grouping (`stripe.webhook`, `cron.holds`). */
  module?: string;
};

const ctxStore = new AsyncLocalStorage<Context>();

/** Run `fn` with the given log context attached. All log.* calls
 *  inside `fn` (and any awaited descendants) will inherit it. */
export function runWithContext<T>(ctx: Context, fn: () => T | Promise<T>): T | Promise<T> {
  return ctxStore.run(ctx, fn);
}

/** Returns the current context or an empty object. Safe outside any
 *  context (no AsyncLocalStorage frame). */
export function currentContext(): Context {
  return ctxStore.getStore() ?? {};
}

function emit(level: LogLevel, evt: string, data?: Record<string, unknown>) {
  try {
    const ctx = currentContext();
    const line = {
      ts: new Date().toISOString(),
      level,
      evt,
      ...ctx,
      ...(data ?? {}),
    };
    const out = JSON.stringify(line, replacer);
    if (level === "error") {
      // eslint-disable-next-line no-console
      console.error(out);
    } else if (level === "warn") {
      // eslint-disable-next-line no-console
      console.warn(out);
    } else {
      // eslint-disable-next-line no-console
      console.log(out);
    }
  } catch {
    /* never throw from a logger */
  }
}

/** JSON.stringify replacer: handle Error, BigInt, redact obvious
 *  secret-looking keys. */
function replacer(key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "bigint") return value.toString();
  const lower = key.toLowerCase();
  if (
    lower.includes("password") ||
    lower.includes("secret") ||
    lower.endsWith("_key") ||
    lower === "token"
  ) {
    return typeof value === "string" && value.length > 0 ? "[REDACTED]" : value;
  }
  return value;
}

export const log = {
  debug: (evt: string, data?: Record<string, unknown>) => emit("debug", evt, data),
  info: (evt: string, data?: Record<string, unknown>) => emit("info", evt, data),
  warn: (evt: string, data?: Record<string, unknown>) => emit("warn", evt, data),
  error: (evt: string, data?: Record<string, unknown>) => emit("error", evt, data),
};

/** Generate an opaque correlation id for a request. Falls back to
 *  Math.random when crypto.randomUUID isn't available (very old Node). */
export function newRequestId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {}
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

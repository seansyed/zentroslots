// Ambient declarations for OPTIONAL runtime dependencies. The actual
// packages are not installed by default — they're loaded only if the
// tenant configures the corresponding env var (e.g. SENTRY_DSN). The
// dynamic import in lib/logger.ts swallows the not-found error at
// runtime; this file just keeps the TypeScript checker happy.
declare module "@sentry/node" {
  export function init(o: { dsn: string }): void;
  export function captureException(e: unknown, ctx?: Record<string, unknown>): void;
}

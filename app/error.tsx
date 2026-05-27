"use client";

import { useEffect } from "react";

/**
 * Detect Next.js ChunkLoadError — fires when the user's cached HTML
 * references JS chunks from a previous build that no longer exist on
 * the CDN. Classic after every deploy. The cleanest recovery is a
 * single hard reload: the browser fetches the current HTML, which
 * points at the current chunk hashes.
 *
 * Guard against infinite reload loops with a sessionStorage flag —
 * if a reload already happened in this session and the same chunk
 * still fails, we fall through to the friendly error UI instead.
 */
function isChunkLoadError(err: Error): boolean {
  if (!err) return false;
  const name = err.name ?? "";
  const msg = err.message ?? "";
  return (
    name === "ChunkLoadError" ||
    /Loading chunk \w+ failed/i.test(msg) ||
    /Loading CSS chunk \w+ failed/i.test(msg) ||
    /ChunkLoadError/i.test(msg)
  );
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Page error:", error);

    // Auto-recover stale-build chunk errors. One hard reload per session
    // — if the same chunk fails again after reload, we surface the UI.
    if (typeof window !== "undefined" && isChunkLoadError(error)) {
      try {
        const KEY = "zm_chunk_reload_at";
        const last = window.sessionStorage.getItem(KEY);
        const now = Date.now();
        if (!last || now - Number(last) > 30_000) {
          window.sessionStorage.setItem(KEY, String(now));
          window.location.reload();
          return;
        }
      } catch {
        // sessionStorage unavailable — fall through to error UI
      }
    }

    try {
      const payload = {
        message: error.message,
        digest: error.digest,
        stack: error.stack?.slice(0, 4000),
        path: typeof window !== "undefined" ? window.location.pathname : null,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
        ts: new Date().toISOString(),
      };
      fetch("/api/log/client-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6" aria-hidden>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v5M12 16h.01" />
        </svg>
      </div>
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-slate-600">
        We&rsquo;ve been notified. Try again — most issues resolve on retry.
      </p>
      {error.digest && (
        <p className="mt-2 font-mono text-xs text-slate-400">ref: {error.digest}</p>
      )}
      <div className="mt-6 flex gap-2">
        <button
          onClick={() => reset()}
          className="rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Try again
        </button>
        <a
          href="/"
          className="rounded-md border bg-white px-4 py-2 text-sm hover:bg-slate-50"
        >
          Go home
        </a>
      </div>
    </div>
  );
}

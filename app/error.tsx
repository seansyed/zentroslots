"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Detailed client-side logging for production debug. Server-side
    // errors carry only `digest` on the client (Next.js redacts the
    // message + stack for security), so we POST a beacon to /api/log/
    // client-error so operators can see what surface crashed.
    console.error("Page error:", error);
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

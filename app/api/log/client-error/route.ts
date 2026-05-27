/**
 * /api/log/client-error
 *
 * Client-side error beacon. POST'd by app/error.tsx when a render or
 * runtime error trips the Next.js error boundary in the browser. The
 * payload is logged to stderr with a `client_error` event prefix so
 * `pm2 logs scheduling-saas --err` can be grep'd for client crashes
 * the same way as server crashes.
 *
 * Strict rules:
 *   • No DB writes — keep this endpoint cheap and impossible to break
 *   • No auth — the error boundary fires for unauthenticated visitors too
 *   • Tiny payload only — message + digest + stack + path
 *   • Truncate everything so a bad/huge body can't blow the log
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const safe = {
      evt: "client_error",
      msg: typeof body?.message === "string" ? body.message.slice(0, 500) : null,
      digest: typeof body?.digest === "string" ? body.digest.slice(0, 60) : null,
      path: typeof body?.path === "string" ? body.path.slice(0, 200) : null,
      ua: typeof body?.userAgent === "string" ? body.userAgent.slice(0, 200) : null,
      stack: typeof body?.stack === "string" ? body.stack.slice(0, 2000) : null,
      ts: typeof body?.ts === "string" ? body.ts.slice(0, 32) : new Date().toISOString(),
    };
    // Single-line JSON so the log line stays grep-friendly
    console.error(JSON.stringify(safe));
  } catch {
    // Silent — this endpoint must never throw
  }
  return NextResponse.json({ ok: true });
}

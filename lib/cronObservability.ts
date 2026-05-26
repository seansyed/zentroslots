/**
 * Stabilization Wave — cron observability wrapper.
 *
 * Wraps a cron worker's main body so the diagnostics panel and /api/health
 * have a deterministic "last run" / "last result" signal without scraping
 * stdout logs.
 *
 *   await withCronRun("holds:expire", async (ctx) => {
 *     ctx.detail({ candidates, ok, failed });
 *     // ... real work ...
 *   });
 *
 * Guarantees:
 *   - Always writes one cron_runs row per call (start), updated to ok|failed
 *     when the body resolves / rejects.
 *   - Never throws. Per-row failures are swallowed; the outer body's
 *     exit code is unchanged from before the wrapper.
 *   - Adopts the existing PM2 process model — no daemonization, no
 *     long-lived state. One row per process exit.
 *
 * Soft-fail: if the cron_runs table is missing (migration not yet
 * applied) or the DB is unreachable, this helper falls back to stdout
 * JSON logging only. The cron's actual work runs regardless.
 */
import os from "node:os";

import { db } from "@/db/client";
import { cronRuns } from "@/db/schema";
import { eq } from "drizzle-orm";

export type CronRunContext = {
  /** Attach structured detail (counts, error reasons). Overwrites
   *  prior detail; safe to call repeatedly. */
  detail: (data: Record<string, unknown>) => void;
};

export async function withCronRun<T>(
  jobName: string,
  fn: (ctx: CronRunContext) => Promise<T>,
): Promise<T> {
  const hostname = (() => {
    try {
      return os.hostname().slice(0, 120);
    } catch {
      return null;
    }
  })();

  let runId: string | null = null;
  let pendingDetail: Record<string, unknown> = {};

  const ctx: CronRunContext = {
    detail: (data) => {
      pendingDetail = { ...pendingDetail, ...data };
    },
  };

  // Best-effort insert. If this fails (table missing, DB down) we
  // continue without observability so the actual cron still runs.
  try {
    const inserted = await db
      .insert(cronRuns)
      .values({
        jobName,
        host: hostname,
        status: "running",
        detail: {},
      })
      .returning({ id: cronRuns.id });
    runId = inserted[0]?.id ?? null;
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "cron_runs.insert_fail",
        job: jobName,
        reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      }),
    );
  }

  const started = Date.now();
  try {
    const result = await fn(ctx);
    const durationMs = Date.now() - started;
    if (runId) {
      try {
        await db
          .update(cronRuns)
          .set({
            finishedAt: new Date(),
            durationMs,
            status: "ok",
            detail: pendingDetail,
          })
          .where(eq(cronRuns.id, runId));
      } catch (err) {
        console.error(
          JSON.stringify({
            evt: "cron_runs.finish_fail",
            job: jobName,
            reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
          }),
        );
      }
    }
    console.log(
      JSON.stringify({
        evt: "cron.run.ok",
        job: jobName,
        ms: durationMs,
        ...pendingDetail,
      }),
    );
    return result;
  } catch (err) {
    const durationMs = Date.now() - started;
    const reason = err instanceof Error ? err.message.slice(0, 500) : "unknown";
    if (runId) {
      try {
        await db
          .update(cronRuns)
          .set({
            finishedAt: new Date(),
            durationMs,
            status: "failed",
            detail: { ...pendingDetail, error: reason },
          })
          .where(eq(cronRuns.id, runId));
      } catch {}
    }
    console.error(
      JSON.stringify({
        evt: "cron.run.failed",
        job: jobName,
        ms: durationMs,
        reason,
      }),
    );
    throw err;
  }
}

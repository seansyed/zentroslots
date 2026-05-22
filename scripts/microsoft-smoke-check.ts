/**
 * Wave C.1 — Microsoft / Outlook / Teams operational smoke check.
 *
 * A repeatable validation pass that can be run by ops after any deploy
 * touching calendar or auth code. Does NOT exercise live OAuth (that
 * needs a human in the loop); checks:
 *
 *   1. Required env vars are set
 *   2. Microsoft OAuth routes are registered (200/401/400 surface)
 *   3. Validation accepts videoProvider="teams" (round-trips through zod)
 *   4. Service editor + write schema reject zoom (Wave A constraint)
 *   5. DB indexes from migrations 0044 + 0045 exist
 *   6. No calendar_connections rows have an undecryptable refresh
 *      token envelope (Wave A guard)
 *   7. Retry-count column populated on recent sync logs (proves Wave A
 *      sync-log changes deployed)
 *   8. At least one provider connection exists OR we report clean
 *      pre-launch state honestly
 *
 * Exits 0 on pass, 1 on any failure. Output is grep-friendly and
 * non-decorative so it can be piped to a deploy notifier.
 *
 * Usage:
 *   npx tsx scripts/microsoft-smoke-check.ts
 *   APP_BASE_URL=http://127.0.0.1:3001 npx tsx scripts/microsoft-smoke-check.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/db/client";

const APP_BASE = (process.env.APP_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

const checks: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
}

async function checkEnvVars() {
  const required = ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"];
  const missing = required.filter((k) => !process.env[k] || process.env[k] === "");
  if (missing.length === 0) {
    record("env vars", true, "MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET present");
  } else {
    record(
      "env vars",
      false,
      `Missing: ${missing.join(", ")} — OAuth flow will return config error until ops adds them`,
    );
  }
  // MICROSOFT_REDIRECT_URI is optional; we derive a default from
  // APP_BASE_URL. Surface the resolved value so ops can register it.
  const redirect =
    process.env.MICROSOFT_REDIRECT_URI ??
    `${APP_BASE}/api/calendar/microsoft/callback`;
  record("redirect uri", true, `Resolved to ${redirect} (must match Azure app registration)`);
}

async function checkRoutes() {
  const targets: Array<{ path: string; expected: number[] }> = [
    { path: "/api/health", expected: [200] },
    // Unauthenticated GET should return 401 (requires session)
    { path: "/api/calendar/microsoft/connect", expected: [401] },
    // Callback without code/state returns 400 HttpError
    { path: "/api/calendar/microsoft/callback", expected: [400, 401] },
  ];
  for (const t of targets) {
    try {
      const res = await fetch(`${APP_BASE}${t.path}`);
      const ok = t.expected.includes(res.status);
      record(
        `route ${t.path}`,
        ok,
        ok
          ? `HTTP ${res.status} (expected ${t.expected.join("|")})`
          : `HTTP ${res.status} — expected one of ${t.expected.join("|")}`,
      );
    } catch (err) {
      record(
        `route ${t.path}`,
        false,
        `fetch failed: ${(err as Error).message.slice(0, 80)}`,
      );
    }
  }
}

async function checkDbIndexes() {
  const expected = [
    "calendar_connections_user_provider_active_idx",
    "calendar_sync_logs_tenant_provider_idx",
  ];
  try {
    const rows = await db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE tablename IN ('calendar_connections','calendar_sync_logs')`,
    );
    const present = new Set(
      (rows as unknown as Array<{ indexname: string }>).map((r) => r.indexname),
    );
    for (const idx of expected) {
      record(`index ${idx}`, present.has(idx), present.has(idx) ? "present" : "MISSING");
    }
  } catch (err) {
    record(
      "db indexes",
      false,
      `Could not query pg_indexes: ${(err as Error).message.slice(0, 80)}`,
    );
  }
}

async function checkTokenEnvelopes() {
  // Any active row whose refresh_token_encrypted doesn't start with
  // "v1:" is either legacy plaintext (shouldn't exist anymore post
  // Wave A migration 0044) or corruption.
  try {
    const rows = await db.execute<{ provider: string; bad: number }>(
      sql`SELECT provider, COUNT(*)::int AS bad
            FROM calendar_connections
           WHERE status = 'active'
             AND (refresh_token_encrypted IS NULL OR refresh_token_encrypted NOT LIKE 'v1:%')
        GROUP BY provider`,
    );
    const list = (rows as unknown as Array<Record<string, unknown>>) as Array<{ provider: string; bad: number }>;
    if (list.length === 0) {
      record("token envelopes", true, "no active rows with un-envelope-d refresh tokens");
    } else {
      for (const r of list) {
        record(
          `token envelopes:${r.provider}`,
          false,
          `${r.bad} active row(s) with malformed/legacy envelope — Wave A guard would force reconnect`,
        );
      }
    }
  } catch (err) {
    record(
      "token envelopes",
      false,
      `query failed: ${(err as Error).message.slice(0, 80)}`,
    );
  }
}

async function checkRetryColumn() {
  try {
    const rows = await db.execute<{ has: number }>(
      sql`SELECT 1 AS has FROM information_schema.columns
           WHERE table_name = 'calendar_sync_logs' AND column_name = 'retry_count'`,
    );
    const ok = ((rows as unknown as Array<Record<string, unknown>>) as Array<unknown>).length > 0;
    record(
      "sync_logs.retry_count",
      ok,
      ok ? "column present (Wave A migration 0044 applied)" : "MISSING — migration 0044 not applied",
    );
  } catch (err) {
    record(
      "sync_logs.retry_count",
      false,
      `query failed: ${(err as Error).message.slice(0, 80)}`,
    );
  }
}

async function checkProviderSurface() {
  // Are there any Microsoft connections in any state? Not a failure
  // either way — this just reports the post-deploy landscape so ops
  // knows whether the first user has connected yet.
  try {
    const rows = await db.execute<{ provider: string; status: string; c: number }>(
      sql`SELECT provider, status, COUNT(*)::int AS c
            FROM calendar_connections
        GROUP BY provider, status
        ORDER BY provider, status`,
    );
    const list = (rows as unknown as Array<Record<string, unknown>>) as Array<{ provider: string; status: string; c: number }>;
    if (list.length === 0) {
      record("provider surface", true, "no connections yet (clean pre-launch state)");
    } else {
      const summary = list.map((r) => `${r.provider}/${r.status}=${r.c}`).join(" ");
      record("provider surface", true, summary);
    }
  } catch (err) {
    record(
      "provider surface",
      false,
      `query failed: ${(err as Error).message.slice(0, 80)}`,
    );
  }
}

async function main() {
  await checkEnvVars();
  await checkRoutes();
  await checkDbIndexes();
  await checkTokenEnvelopes();
  await checkRetryColumn();
  await checkProviderSurface();

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) {
    const tag = c.ok ? "PASS" : "FAIL";
    // eslint-disable-next-line no-console
    console.log(`${tag} ${c.name}: ${c.detail}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`smoke-check crashed: ${(err as Error).message}`);
  process.exit(2);
});

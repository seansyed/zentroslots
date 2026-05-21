/**
 * Cloudflare Custom Hostnames — production edge integration.
 *
 * Wraps the Cloudflare API endpoints we need to provision automatic
 * TLS for tenant custom hostnames. Used by:
 *   - /api/tenant/domains/[id]/verify  (provision after TXT verifies)
 *   - /api/tenant/domains/[id]         (cleanup on delete)
 *   - /api/tenant/domains/[id]/refresh (manual SSL state poll)
 *   - scripts/sync-domain-ssl.ts       (background SSL sync cron)
 *
 * Required env vars:
 *   CLOUDFLARE_API_TOKEN                 — token with #zone:edit scope
 *                                          on the target zone
 *   CLOUDFLARE_ZONE_ID                   — the zone id of the
 *                                          *.zentromeet.com fallback
 *                                          zone hosting edge.zentromeet.com
 *   CLOUDFLARE_ACCOUNT_ID                — optional (account-scoped
 *                                          analytics later)
 *   CLOUDFLARE_CUSTOM_HOSTNAME_FALLBACK  — public CNAME target (e.g.
 *                                          edge.zentromeet.com)
 *   CLOUDFLARE_ORIGIN_SERVER             — optional, for sanity logs;
 *                                          actual origin lives in the
 *                                          zone DNS, not the SaaS code
 *
 * Honest-architecture discipline:
 *   - When CLOUDFLARE_API_TOKEN is unset, every function returns a
 *     soft-failure tuple. We NEVER mark ssl_status="active" without
 *     a real Cloudflare response.
 *   - All fetches have a 15s timeout (SSRF safety + responsiveness).
 *   - Non-200 responses surface the CF error message back to the
 *     caller so it can be persisted into verification_errors.
 */

// ─── Configuration ───────────────────────────────────────────────

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const CF_TIMEOUT_MS = 15_000;

// Retry policy for transient failures. Cloudflare's API occasionally
// 429/502/504s under load — retry with exponential backoff on safe
// methods only (GET/DELETE — POST/PUT carry mutation risk).
const CF_RETRY_ATTEMPTS = 3;
const CF_RETRY_BACKOFF_MS = [250, 750]; // 250ms, 750ms (1st + 2nd retry)
const CF_RETRY_STATUS = new Set([408, 425, 429, 502, 503, 504]);
const CF_RETRY_METHODS = new Set(["GET", "DELETE", undefined]);

export function cloudflareConfigured(): boolean {
  return !!(
    process.env.CLOUDFLARE_API_TOKEN &&
    process.env.CLOUDFLARE_ZONE_ID
  );
}

export function cloudflareConfig() {
  return {
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
    zoneId: process.env.CLOUDFLARE_ZONE_ID ?? "",
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    fallback: (
      process.env.CLOUDFLARE_CUSTOM_HOSTNAME_FALLBACK ?? "edge.zentromeet.com"
    ).toLowerCase().replace(/\.$/, ""),
    originServer: process.env.CLOUDFLARE_ORIGIN_SERVER ?? "",
  };
}

// ─── Types ───────────────────────────────────────────────────────

/**
 * Cloudflare's reported state machine for a Custom Hostname.
 * Cf returns these for `status` and `ssl.status`.
 *   active                — cert issued + serving
 *   pending               — initial enrollment
 *   active_redeploying    — in progress
 *   moved | deleted | blocked — terminal
 *   pending_validation    — waiting for DNS validation
 *   pending_issuance      — cert request submitted
 *   pending_deployment    — cert built, edge picking it up
 *   pending_deletion      — being torn down
 *   initializing          — fresh
 */
export type CfHostnameSslStatus =
  | "active"
  | "pending"
  | "pending_validation"
  | "pending_issuance"
  | "pending_deployment"
  | "pending_deletion"
  | "initializing"
  | "deleted"
  | "blocked"
  | "moved"
  | "active_redeploying";

export type CfHostname = {
  id: string;
  hostname: string;
  status: CfHostnameSslStatus | string;
  ssl: {
    status: CfHostnameSslStatus | string;
    method?: string;
    type?: string;
    validation_errors?: { message: string }[];
  };
  verification_errors?: string[];
  created_at?: string;
};

export type CfOk<T> = { ok: true; result: T };
export type CfErr = { ok: false; status: number; message: string };
export type CfResponse<T> = CfOk<T> | CfErr;

// ─── Internal fetch wrapper ──────────────────────────────────────

async function cfFetch<T>(path: string, init?: RequestInit): Promise<CfResponse<T>> {
  if (!cloudflareConfigured()) {
    return {
      ok: false,
      status: 503,
      message: "Cloudflare API not configured (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID missing)",
    };
  }
  const { apiToken } = cloudflareConfig();
  const url = `${CF_API_BASE}${path}`;
  const method = init?.method as string | undefined;
  const retriable = CF_RETRY_METHODS.has(method);
  const maxAttempts = retriable ? CF_RETRY_ATTEMPTS : 1;

  let lastErr: CfErr = { ok: false, status: 0, message: "Cloudflare API call failed" };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CF_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
          ...(init?.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });
      let data: { success?: boolean; result?: unknown; errors?: { message: string; code?: number }[] } = {};
      try {
        data = (await res.json()) as typeof data;
      } catch {
        // Non-JSON response — treat as failure but allow retry if eligible
        lastErr = { ok: false, status: res.status, message: `Cloudflare returned non-JSON (HTTP ${res.status})` };
        if (!CF_RETRY_STATUS.has(res.status) || attempt === maxAttempts - 1) {
          return lastErr;
        }
        const wait = CF_RETRY_BACKOFF_MS[attempt] ?? 1500;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (res.ok && (data.success ?? true)) {
        return { ok: true, result: (data.result ?? null) as T };
      }
      const msg = data.errors?.[0]?.message ?? `Cloudflare API error (HTTP ${res.status})`;
      lastErr = { ok: false, status: res.status, message: msg };

      // Don't retry permanent failures (4xx auth/permission/validation).
      if (!CF_RETRY_STATUS.has(res.status) || attempt === maxAttempts - 1) {
        return lastErr;
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        lastErr = { ok: false, status: 504, message: "Cloudflare API timeout" };
      } else {
        lastErr = {
          ok: false,
          status: 0,
          message: err instanceof Error ? err.message : "Cloudflare API call failed",
        };
      }
      if (attempt === maxAttempts - 1) return lastErr;
    } finally {
      clearTimeout(timeout);
    }
    // Exponential backoff before next attempt
    const wait = CF_RETRY_BACKOFF_MS[attempt] ?? 1500;
    await new Promise((r) => setTimeout(r, wait));
  }
  return lastErr;
}

// ─── Token / zone health verification (Phase 15D Part 3) ─────────

export type CfHealthcheck = {
  configured: boolean;
  tokenOk: boolean;
  zoneOk: boolean;
  customHostnamesOk: boolean;
  zoneName?: string;
  errors: string[];
};

/**
 * Cheap server-side check that the configured Cloudflare credentials
 * actually work. Hits three endpoints in sequence so a partial
 * permission grant surfaces the exact missing scope:
 *
 *   1. /user/tokens/verify  — token alive + not revoked
 *   2. /zones/{zoneId}      — zone access + correct id
 *   3. /zones/{zoneId}/custom_hostnames?per_page=1 — SaaS feature enabled
 *
 * Used by the /api/health endpoint and by ops scripts. Never throws.
 */
export async function cloudflareHealthcheck(): Promise<CfHealthcheck> {
  const out: CfHealthcheck = {
    configured: cloudflareConfigured(),
    tokenOk: false,
    zoneOk: false,
    customHostnamesOk: false,
    errors: [],
  };
  if (!out.configured) {
    out.errors.push("CLOUDFLARE_API_TOKEN and/or CLOUDFLARE_ZONE_ID not set");
    return out;
  }

  const verify = await cfFetch<{ status?: string }>("/user/tokens/verify");
  if (verify.ok) {
    out.tokenOk = true;
  } else {
    out.errors.push(`token verify failed: ${verify.message}`);
    return out;
  }

  const { zoneId } = cloudflareConfig();
  const zone = await cfFetch<{ name?: string }>(`/zones/${zoneId}`);
  if (zone.ok) {
    out.zoneOk = true;
    out.zoneName = zone.result?.name;
  } else {
    out.errors.push(`zone access failed: ${zone.message}`);
    return out;
  }

  const ch = await cfFetch<unknown[]>(`/zones/${zoneId}/custom_hostnames?per_page=1`);
  if (ch.ok) {
    out.customHostnamesOk = true;
  } else {
    out.errors.push(`custom_hostnames access failed: ${ch.message}`);
  }
  return out;
}

// ─── Custom Hostname operations ──────────────────────────────────

/**
 * Provision a Cloudflare Custom Hostname for the given customer
 * hostname. This is called AFTER our own TXT verification passes —
 * Cloudflare then issues a Let's Encrypt / Google Trust Services
 * certificate as soon as the customer's CNAME points to our fallback.
 *
 * Returns the new CfHostname.id which we persist in cf_hostname_id.
 */
export async function createCustomHostname(
  hostname: string,
): Promise<CfResponse<CfHostname>> {
  const { zoneId } = cloudflareConfig();
  // Minimal body — works on Free / Pro / Business / Enterprise.
  // Enterprise-only fields removed (Phase 15D validation):
  //   - certificate_authority    → CF picks "google" by default
  //   - ssl.settings.ciphers     → Enterprise-tier feature
  //   - ssl.settings.http2/tls   → Enterprise-tier feature (controlled
  //                                at the zone level instead, which we
  //                                already configured in §3 of the
  //                                operator runbook)
  //   - ssl.bundle_method        → Enterprise-tier feature
  // Cloudflare's defaults give us TLS 1.2/1.3 + HTTP/2 + HTTP/3 + the
  // ubiquitous bundle method, so removing these doesn't reduce
  // posture — it just removes the API-level overrides our plan
  // doesn't grant.
  const body = {
    hostname,
    ssl: {
      method: "http", // HTTP DCV — simplest path, works once CNAME lands
      type: "dv",     // domain-validated (the default cert type)
    },
  };
  return cfFetch<CfHostname>(`/zones/${zoneId}/custom_hostnames`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Delete a Custom Hostname from Cloudflare. Idempotent on 404. */
export async function deleteCustomHostname(
  cfId: string,
): Promise<CfResponse<{ id: string }>> {
  const { zoneId } = cloudflareConfig();
  const r = await cfFetch<{ id: string }>(`/zones/${zoneId}/custom_hostnames/${cfId}`, {
    method: "DELETE",
  });
  // Treat 404 as success — caller already considers this gone.
  if (!r.ok && r.status === 404) return { ok: true, result: { id: cfId } };
  return r;
}

/** Fetch current state for a single CF Custom Hostname. */
export async function refreshHostnameStatus(
  cfId: string,
): Promise<CfResponse<CfHostname>> {
  const { zoneId } = cloudflareConfig();
  return cfFetch<CfHostname>(`/zones/${zoneId}/custom_hostnames/${cfId}`);
}

// ─── Status mapping ─────────────────────────────────────────────

/**
 * Map Cloudflare's ssl.status string to our condensed enum. Our DB
 * column is varchar(32) so we keep CF's exact string when there's no
 * cleaner mapping — that way operators can see the real state in
 * verification_errors / logs.
 *
 * Returns:
 *   active                    when CF reports "active"
 *   pending_validation        when CF is waiting for the customer's CNAME
 *   ssl_pending               for any other in-flight CF state
 *   failed                    for deleted / blocked / moved terminal
 */
export function mapCfSslStatus(cfStatus: string | undefined): {
  status: "active" | "pending_validation" | "ssl_pending" | "failed";
  raw: string;
} {
  const raw = (cfStatus ?? "").toLowerCase();
  if (raw === "active") return { status: "active", raw };
  if (raw === "pending_validation") return { status: "pending_validation", raw };
  if (raw === "deleted" || raw === "blocked" || raw === "moved") {
    return { status: "failed", raw };
  }
  if (raw === "") return { status: "ssl_pending", raw };
  // pending_issuance, pending_deployment, initializing, pending,
  // active_redeploying, pending_deletion → all "in flight"
  return { status: "ssl_pending", raw };
}

/** Extract the first validation error message, if any, from a CF
 *  hostname for surfacing in the operator UI. */
export function extractCfErrors(h: CfHostname): string | null {
  const ssl = h.ssl?.validation_errors?.[0]?.message;
  if (ssl) return ssl;
  const top = h.verification_errors?.[0];
  if (top) return top;
  return null;
}

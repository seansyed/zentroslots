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
    let data: { success?: boolean; result?: unknown; errors?: { message: string }[] };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      return { ok: false, status: res.status, message: `Cloudflare returned non-JSON (HTTP ${res.status})` };
    }
    if (!res.ok || data?.success === false) {
      const msg = data?.errors?.[0]?.message ?? `Cloudflare API error (HTTP ${res.status})`;
      return { ok: false, status: res.status, message: msg };
    }
    return { ok: true, result: data.result as T };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, status: 504, message: "Cloudflare API timeout" };
    }
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? err.message : "Cloudflare API call failed",
    };
  } finally {
    clearTimeout(timeout);
  }
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
  const body = {
    hostname,
    ssl: {
      method: "http",
      type: "dv",
      settings: {
        http2: "on",
        min_tls_version: "1.2",
        tls_1_3: "on",
        // Modern ciphers — Cloudflare default list is fine; we set
        // these explicitly so future audits can grep the source.
        ciphers: ["ECDHE-ECDSA-AES128-GCM-SHA256", "ECDHE-RSA-AES128-GCM-SHA256"],
      },
      bundle_method: "ubiquitous",
      wildcard: false,
      certificate_authority: "google",
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

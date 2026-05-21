/**
 * Custom Domains — Phase 15A foundation.
 *
 * Pure utilities + real DNS resolution + tenant-aware hostname lookup
 * with a TTL cache. Used by:
 *   - /api/tenant/domains             (CRUD)
 *   - /api/tenant/domains/[id]/verify (DNS verification)
 *   - middleware.ts                   (per-request hostname routing)
 *   - app/dashboard/settings/domain   (UI hydration)
 *
 * No fake verification. DNS lookups use `node:dns/promises` against
 * the system resolver. SSL status is plumbing-only — actual cert
 * issuance is delegated to the edge (Caddy / Cloudflare SSL for SaaS
 * / AWS ACM) and reflected back when wired.
 */

import dns from "node:dns/promises";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantDomains, tenants } from "@/db/schema";

// ─── Configuration ───────────────────────────────────────────────

/** CNAME target customers point their hostnames at. Phase 15C wires
 *  this to the Cloudflare custom-hostname fallback so the platform
 *  edge serves the booking page directly with automatic TLS.
 *
 *  Priority order (first present wins):
 *    1. CLOUDFLARE_CUSTOM_HOSTNAME_FALLBACK  (production edge)
 *    2. DOMAINS_CNAME_TARGET                  (manual override)
 *    3. "edge.zentromeet.com"                 (sensible default)
 */
export const CNAME_TARGET = (
  process.env.CLOUDFLARE_CUSTOM_HOSTNAME_FALLBACK ??
  process.env.DOMAINS_CNAME_TARGET ??
  "edge.zentromeet.com"
).toLowerCase().replace(/\.$/, "");

/** TXT prefix used to scope the verification record under the host.
 *  Phase 15C aligned to "_zentromeet-verify" per ops convention. */
export const TXT_PREFIX = process.env.DOMAINS_TXT_PREFIX ?? "_zentromeet-verify";

/** Hostnames that ALWAYS bypass custom-domain routing — the app's own
 *  surfaces, local dev, and direct-IP access. */
const CANONICAL_HOSTNAMES = new Set<string>(
  [
    process.env.APP_HOSTNAME,
    process.env.NEXT_PUBLIC_APP_HOSTNAME,
    "app.zentromeet.com",
    "zentromeet.com",
    "www.zentromeet.com",
    "localhost",
    "127.0.0.1",
  ].filter(Boolean).map((h) => h!.toLowerCase()),
);

// ─── Normalization + validation ──────────────────────────────────

const HOST_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_RE = /^\[?[0-9a-f:]+\]?$/i;

export function normalizeHostname(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, "");
}

/** True if this hostname is the app itself or a raw IP — should never
 *  participate in tenant routing. */
export function isCanonicalHost(host: string): boolean {
  const h = normalizeHostname(host);
  if (!h) return true;
  if (CANONICAL_HOSTNAMES.has(h)) return true;
  if (IPV4_RE.test(h)) return true;
  if (IPV6_RE.test(h)) return true;
  // Also treat any subdomain that looks like the canonical app host.
  for (const canon of CANONICAL_HOSTNAMES) {
    if (h.endsWith(`.${canon}`)) return true;
  }
  return false;
}

export type ValidationResult =
  | { ok: true; host: string }
  | { ok: false; error: string };

export function validateHostname(raw: string): ValidationResult {
  const host = normalizeHostname(raw);
  if (!host) return { ok: false, error: "Hostname is required" };
  if (host.length > 253) return { ok: false, error: "Hostname is too long" };
  if (IPV4_RE.test(host) || IPV6_RE.test(host)) {
    return { ok: false, error: "IP addresses are not allowed — use a hostname" };
  }
  if (!HOST_RE.test(host)) {
    return { ok: false, error: "Invalid hostname format" };
  }
  // Require a subdomain — apex/root domains aren't supported because
  // they collide with the customer's main website and break SSL
  // provisioning at the edge.
  const labels = host.split(".");
  if (labels.length < 3) {
    return {
      ok: false,
      error: "Use a subdomain like book.example.com — apex domains aren't supported",
    };
  }
  if (CANONICAL_HOSTNAMES.has(host)) {
    return { ok: false, error: "This hostname is reserved by the platform" };
  }
  for (const canon of CANONICAL_HOSTNAMES) {
    if (host.endsWith(`.${canon}`)) {
      return { ok: false, error: "Hostnames under the platform domain aren't allowed" };
    }
  }
  return { ok: true, host };
}

// ─── DNS instructions ────────────────────────────────────────────

export type DnsRecord = { type: "CNAME" | "TXT"; host: string; value: string };
export type DnsInstructions = { cname: DnsRecord; txt: DnsRecord };

export function dnsInstructions(host: string, verificationToken: string): DnsInstructions {
  return {
    cname: { type: "CNAME", host, value: CNAME_TARGET },
    txt: { type: "TXT", host: `${TXT_PREFIX}.${host}`, value: verificationToken },
  };
}

// ─── DNS verification (real lookups) ─────────────────────────────

export type VerificationOutcome = {
  status: "verified" | "failed";
  sslStatus: "pending" | "active";
  txt: { matched: boolean; observed: string[] };
  cname: { matched: boolean; observed: string[] };
  reason?: string;
  checkedAt: Date;
};

/**
 * Perform live DNS resolution against the system resolver. Verifies
 * either the TXT ownership record OR the CNAME routing record — TXT
 * confirms ownership, CNAME confirms traffic will reach our edge.
 * Either one matching marks the domain verified; both matching also
 * promotes ssl_status from `pending` to a routing-ready state, which
 * future edge integration (Caddy / Cloudflare / ACM) will flip to
 * `active` once the actual certificate is issued.
 */
export async function verifyDomainDns(
  host: string,
  verificationToken: string,
): Promise<VerificationOutcome> {
  const checkedAt = new Date();
  const observedTxt: string[] = [];
  const observedCname: string[] = [];
  let txtMatched = false;
  let cnameMatched = false;

  // TXT record on the verification subdomain
  try {
    const txts = await dns.resolveTxt(`${TXT_PREFIX}.${host}`);
    const flat = txts.map((arr) => arr.join(""));
    observedTxt.push(...flat);
    txtMatched = flat.some((v) => v.trim() === verificationToken);
  } catch {
    // ENOTFOUND / ENODATA — leave as not matched.
  }

  // CNAME record on the customer hostname. Note: many resolvers return
  // an empty array if the hostname resolves via A/AAAA instead of CNAME.
  try {
    const cnames = await dns.resolveCname(host);
    observedCname.push(...cnames.map((c) => c.toLowerCase().replace(/\.$/, "")));
    cnameMatched = observedCname.includes(CNAME_TARGET);
  } catch {
    // Customer may not have CNAME'd yet — that's fine for verification
    // as long as TXT matches. We still surface this in the UI so they
    // know routing won't reach us until CNAME lands.
  }

  const verified = txtMatched || cnameMatched;
  // SSL plumbing: once both records resolve correctly we mark sslStatus
  // as "active" only when the edge has actually provisioned a cert.
  // Until that hook is wired, we keep it at "pending" — never "active".
  // Comment marker for future Cloudflare SSL for SaaS / AWS ACM hook:
  //   SSL_PROVISIONING_HOOK: when the edge confirms cert issuance for
  //   `host`, call setSslStatus(id, "active").
  const sslStatus: VerificationOutcome["sslStatus"] = "pending";

  let reason: string | undefined;
  if (!verified) {
    if (observedTxt.length === 0 && observedCname.length === 0) {
      reason = `No DNS records found for ${host}. Add the TXT record below, then try again.`;
    } else if (observedTxt.length > 0 && !txtMatched) {
      reason = `TXT record found but value didn't match the verification token. Make sure you copied the value exactly.`;
    } else if (observedCname.length > 0 && !cnameMatched) {
      reason = `CNAME found pointing to ${observedCname[0]} — expected ${CNAME_TARGET}.`;
    } else {
      reason = `Neither the TXT verification record nor the CNAME target was found.`;
    }
  }

  return {
    status: verified ? "verified" : "failed",
    sslStatus,
    txt: { matched: txtMatched, observed: observedTxt },
    cname: { matched: cnameMatched, observed: observedCname },
    reason,
    checkedAt,
  };
}

// ─── Hostname → tenant resolver (cached) ─────────────────────────

type HostnameCacheEntry = {
  slug: string | null;
  tenantId: string | null;
  // Whether this entry resolved to a tenant or is a negative cache.
  hit: boolean;
  expires: number;
};

const HOSTNAME_CACHE = new Map<string, HostnameCacheEntry>();
const CACHE_TTL_MS = 60 * 1000;

export type ResolvedTenantHost = { slug: string; tenantId: string };

/**
 * Look up the verified tenant a hostname routes to. Returns null for
 * canonical hosts, unrecognized hosts, and unverified domains.
 *
 * Used by middleware on EVERY request — designed to be cheap:
 *   - Canonical-host short-circuit is in-memory.
 *   - Cache holds positive AND negative results for 60s.
 *   - DB query touches only the unique (normalized_host, status) index.
 */
export async function resolveTenantByHostname(
  hostname: string,
): Promise<ResolvedTenantHost | null> {
  const host = normalizeHostname(hostname);
  if (!host || isCanonicalHost(host)) return null;

  const cached = HOSTNAME_CACHE.get(host);
  if (cached && cached.expires > Date.now()) {
    if (cached.hit && cached.slug && cached.tenantId) {
      return { slug: cached.slug, tenantId: cached.tenantId };
    }
    return null;
  }

  let resolved: ResolvedTenantHost | null = null;
  try {
    const rows = await db
      .select({
        slug: tenants.slug,
        tenantId: tenants.id,
      })
      .from(tenantDomains)
      .innerJoin(tenants, eq(tenants.id, tenantDomains.tenantId))
      .where(
        and(
          eq(tenantDomains.normalizedHost, host),
          eq(tenantDomains.status, "verified"),
          eq(tenants.active, true),
        ),
      )
      .limit(1);
    if (rows[0]) {
      resolved = { slug: rows[0].slug, tenantId: rows[0].tenantId };
    }
  } catch {
    // On DB failure, treat as miss — middleware will pass through and
    // Next will serve the default response. We do NOT cache the failure
    // so the next request retries fresh.
    return null;
  }

  HOSTNAME_CACHE.set(host, {
    slug: resolved?.slug ?? null,
    tenantId: resolved?.tenantId ?? null,
    hit: !!resolved,
    expires: Date.now() + CACHE_TTL_MS,
  });
  return resolved;
}

export function invalidateHostnameCache(hostname?: string): void {
  if (hostname) {
    HOSTNAME_CACHE.delete(normalizeHostname(hostname));
  } else {
    HOSTNAME_CACHE.clear();
  }
}

// ─── Serializer ──────────────────────────────────────────────────
// Lives here (not in route.ts) so multiple API route files can share
// one canonical wire shape. Next.js route files may ONLY export the
// HTTP handler names + config — additional exports break the build.

export type DomainRow = typeof tenantDomains.$inferSelect;

export function serializeDomain(row: DomainRow) {
  return {
    id: row.id,
    host: row.host,
    normalizedHost: row.normalizedHost,
    verificationToken: row.verificationToken,
    status: row.status,
    sslStatus: row.sslStatus,
    cfHostnameId: row.cfHostnameId ?? null,
    verificationErrors: row.verificationErrors ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

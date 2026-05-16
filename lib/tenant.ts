import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, type Tenant } from "@/db/schema";
import { HttpError } from "@/lib/auth";

// ─── Slug generation ────────────────────────────────────────────────────

const SLUG_BLOCKLIST = new Set([
  "api", "app", "auth", "admin", "book", "dashboard", "public",
  "www", "mail", "ftp", "static", "assets", "next", "t", "login",
  "signup", "settings", "default", "system", "root",
]);

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "workspace";
}

export async function generateUniqueSlug(baseName: string): Promise<string> {
  let base = slugify(baseName);
  if (SLUG_BLOCKLIST.has(base)) base = `${base}-ws`;

  // Try base, then base-2, base-3, ... (caps at a sensible bound)
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await db.query.tenants.findFirst({
      where: eq(tenants.slug, candidate),
    });
    if (!existing) return candidate;
  }
  // Fallback — extremely unlikely
  return `${base}-${Date.now().toString(36)}`;
}

// ─── Cross-tenant guards ────────────────────────────────────────────────

/**
 * Throws 403 if any of the provided records is missing OR its tenantId
 * doesn't match the expected tenant. Use whenever a route accepts IDs
 * in the body / URL that resolve to tenant-owned rows.
 */
export function assertSameTenant<
  T extends { tenantId: string } | null | undefined,
>(expectedTenantId: string, ...resources: T[]): void {
  for (const r of resources) {
    if (!r) throw new HttpError(404, "Not found");
    if (r.tenantId !== expectedTenantId) {
      throw new HttpError(403, "Resource belongs to a different workspace");
    }
  }
}

/**
 * Variant for cases where the resource is purely internal (no
 * authenticated tenant context, e.g. public booking creation). Verifies
 * that the provided resources all share the same tenant. Returns that
 * tenant id, throws otherwise.
 */
export function assertResourcesShareTenant<
  T extends { tenantId: string },
>(...resources: T[]): string {
  if (resources.length === 0) throw new HttpError(400, "No resources provided");
  const first = resources[0].tenantId;
  for (const r of resources) {
    if (r.tenantId !== first) {
      throw new HttpError(403, "Resources belong to different workspaces");
    }
  }
  return first;
}

// ─── Lookup helpers ─────────────────────────────────────────────────────

export async function getTenantById(id: string): Promise<Tenant | undefined> {
  return db.query.tenants.findFirst({ where: eq(tenants.id, id) });
}

export async function getTenantBySlug(slug: string): Promise<Tenant | undefined> {
  return db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
}

/**
 * Future-proofing for subdomains: today this is a no-op pass-through
 * for the slug coming from the request body. When subdomains land,
 * swap the implementation to read from the Host header in one place —
 * every caller of this function will pick up the new behavior.
 */
export function resolveTenantSlugFromRequest(opts: {
  bodySlug?: string;
  hostHeader?: string;
}): string | null {
  // TODO(subdomains): when enabled, parse hostHeader (tenant.app.com → "tenant")
  // and prefer it over bodySlug.
  return opts.bodySlug ?? null;
}

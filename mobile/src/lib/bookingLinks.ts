/**
 * Canonical public booking-link builders.
 *
 * The public booking pages are served by the SAME Next.js origin as the API
 * (web + backend are one app), at:
 *   • Tenant page (lists active services):  {base}/u/{tenantSlug}
 *   • Direct service page:                  {base}/u/{tenantSlug}/{serviceSlug}
 *
 * (Confirmed against app/u/[slug]/page.tsx + app/u/[slug]/[serviceSlug]/page.tsx
 * and the web buildDirectLink in components/dashboard/EmbedSnippetsClient.tsx.)
 *
 * Links are built ONLY from authoritative slugs + the configured public base
 * (env.apiBaseUrl, passed in by callers). There is NO user/staff slug, and we
 * deliberately NEVER add the optional `?staff={userId}` param, so a shared link
 * can't leak an internal UUID. Custom domains are admin-only and intentionally
 * not used here — the canonical host always resolves.
 *
 * Pure + dependency-free (base is a parameter) so the builders are unit-testable
 * under node. Call sites pass `env.apiBaseUrl`.
 */

/** Strip trailing slashes from a base so we never produce `//u`. */
function normalizeBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/** Encode a slug segment defensively (slugs are already URL-safe, but guard). */
function seg(slug: string): string {
  return encodeURIComponent(slug.trim());
}

/** `{base}/u/{tenantSlug}` — the tenant/workspace booking page. */
export function tenantBookingUrl(base: string, tenantSlug: string): string {
  return `${normalizeBase(base)}/u/${seg(tenantSlug)}`;
}

/** `{base}/u/{tenantSlug}/{serviceSlug}` — a direct service booking page. */
export function serviceBookingUrl(
  base: string,
  tenantSlug: string,
  serviceSlug: string,
): string {
  return `${normalizeBase(base)}/u/${seg(tenantSlug)}/${seg(serviceSlug)}`;
}

/** A non-empty trimmed string guard for slugs. */
export function hasSlug(slug: string | null | undefined): slug is string {
  return typeof slug === "string" && slug.trim().length > 0;
}

/**
 * URL helpers — pure, dependency-free (unit-testable under plain node).
 */

/**
 * Absolutize an image/asset URL against an API origin.
 *
 * The backend stores uploaded assets (avatars, tenant logos) as RELATIVE
 * paths (e.g. `/uploads/avatars/x.png`). React Native's <Image> cannot
 * load a relative URI, so a relative avatar silently fails and the UI
 * falls back to initials — the "profile image not showing" bug. This
 * prefixes relative paths with `base`; absolute (http/https/protocol-
 * relative) and `data:` URLs pass through untouched. Empty → null.
 */
export function absolutizeUrl(
  url: string | null | undefined,
  base: string,
): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/^(https?:)?\/\//i.test(trimmed) || /^data:/i.test(trimmed)) return trimmed;
  const origin = base.replace(/\/+$/, "");
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${origin}${path}`;
}

/**
 * Global 404 — served by Next.js for every unmatched route across the
 * App Router (deep links, refreshes on stale paths, mistyped URLs).
 *
 * Auth-aware routing:
 *   • If a valid session cookie is present  → primary CTA = /dashboard
 *   • Otherwise                              → primary CTA = /dashboard/login
 *
 * Why server-side: getSession() reads the JWT cookie via next/headers,
 * which is only available in server components. We resolve the CTA
 * target once and hand it down to the client experience for the
 * interactive bits (window.history.back, focus, animation).
 *
 * Safety:
 *   • Pure server component — no DB writes, no API calls
 *   • Wrapped in try/catch so a cookie-decode failure never breaks the
 *     404 page itself (the whole point of this surface is to never
 *     leave a visitor stranded)
 *   • Additive: this file replaces the existing minimal NotFound,
 *     does not touch middleware, layouts, or any other route
 */

import { getSession } from "@/lib/auth";
import NotFoundExperience from "@/components/system/NotFoundExperience";

export const metadata = {
  title: "Page not found · ZentroMeet",
  description: "The page you’re looking for may have been moved, deleted, or never existed.",
};

export default async function NotFound() {
  let authed = false;
  try {
    const session = await getSession();
    authed = Boolean(session?.sub);
  } catch {
    // Session decode failure → treat as unauthenticated. We must never
    // throw from this surface — it's the last-resort recovery page.
    authed = false;
  }

  const primaryHref = authed ? "/dashboard" : "/dashboard/login";
  const primaryLabel = authed ? "Go to dashboard" : "Sign in to ZentroMeet";

  return <NotFoundExperience primaryHref={primaryHref} primaryLabel={primaryLabel} />;
}

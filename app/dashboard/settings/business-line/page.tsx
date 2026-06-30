/**
 * Settings → Business Line (legacy route) — CONSOLIDATED.
 *
 * The standalone Business Line settings surface has been folded into the premium
 * Business Phone page at /dashboard/phone: forwarding-number configuration, the
 * call-forwarding toggle, usage, recent calls, and the dialer all live there now,
 * with proper not-active / setup-pending / active states. This route just
 * redirects any old links/bookmarks so there's a single, polished page.
 *
 * (Kept as a redirect rather than deleted so existing URLs don't 404.)
 */

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function BusinessLineSettingsRedirect() {
  redirect("/dashboard/phone");
}

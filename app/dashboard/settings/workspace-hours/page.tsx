import { redirect } from "next/navigation";

// Phase 16C consolidation — the Workforce Availability Intelligence
// Center now lives at /dashboard/availability (the destination the
// sidebar "Working hours" entry has always pointed at). This route
// stays as a redirect so any old bookmark or internal link
// continues to resolve cleanly.

export const dynamic = "force-dynamic";

export default function WorkspaceHoursRedirect() {
  redirect("/dashboard/availability");
}

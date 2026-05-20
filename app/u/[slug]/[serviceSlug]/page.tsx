import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, isNull, or } from "drizzle-orm";

import { db } from "@/db/client";
import { departments, serviceStaff, services, staffAssignmentRules, tenants, users } from "@/db/schema";
import BookingFlow from "@/components/BookingFlow";

/**
 * Public service booking page — Phase 14A staff identity + service
 * context refinement.
 *
 * UI/data refinement only. Booking architecture, routing, timezone
 * handling, public booking URLs, and the slots endpoint are all
 * preserved verbatim. The enrichment is purely additive:
 *
 *   - Staff query now fetches avatarUrl, bio, specialties,
 *     googleRefreshToken (for the calendar-sync trust signal),
 *     and joined departments.name (used as "professional title" —
 *     it's a real org concept and we don't invent fake titles).
 *   - The flat "with X" chip is replaced by a richer
 *     StaffIdentityBlock zone that humanizes who the customer is
 *     booking with.
 *   - A meeting-platform chip is added in the service meta row,
 *     derived honestly from service.videoProvider.
 *
 * Honest-data discipline: no reviews, no response-time stats, no
 * popularity counters — those have no backing data today. The
 * StaffIdentityBlock is structurally extensible so a future phase
 * with real data can plug them in.
 */
export default async function PublicServicePage(props: {
  params: Promise<{ slug: string; serviceSlug: string }>;
  searchParams: Promise<{ staff?: string }>;
}) {
  const { slug, serviceSlug } = await props.params;
  const sp = await props.searchParams;

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant || !tenant.active) notFound();

  const service = await db.query.services.findFirst({
    where: and(eq(services.tenantId, tenant.id), eq(services.slug, serviceSlug)),
  });
  if (!service || service.isActive !== 1) notFound();

  // Find a staff member who delivers this service. ?staff=<id> picks
  // a specific one; otherwise default to the first. Query shape
  // expanded to carry the identity fields the booking page now
  // displays — same join, more columns.
  const assignments = await db
    .select({
      userId: serviceStaff.userId,
      name: users.name,
      avatarUrl: users.avatarUrl,
      bio: users.bio,
      specialties: users.specialties,
      googleRefreshToken: users.googleRefreshToken,
      departmentId: users.departmentId,
      departmentName: departments.name,
    })
    .from(serviceStaff)
    .innerJoin(users, eq(users.id, serviceStaff.userId))
    .leftJoin(departments, eq(departments.id, users.departmentId))
    .where(and(
      eq(serviceStaff.serviceId, service.id),
      eq(serviceStaff.tenantId, tenant.id)
    ));
  if (assignments.length === 0) notFound();

  const staff = sp.staff
    ? assignments.find((a) => a.userId === sp.staff) ?? assignments[0]
    : assignments[0];

  // Routing intent — when a non-manual rule applies to this service
  // or the tenant default is non-manual, the booking is routed at
  // insert time by lib/routing/assignStaff. We surface that to the
  // customer here as "Next available specialist" instead of pinning
  // a name. Slots view still reads from the preselected staff's
  // availability.
  const routingRules = await db
    .select()
    .from(staffAssignmentRules)
    .where(
      and(
        eq(staffAssignmentRules.tenantId, tenant.id),
        or(
          eq(staffAssignmentRules.serviceId, service.id),
          and(isNull(staffAssignmentRules.serviceId), isNull(staffAssignmentRules.locationId))
        )
      )
    );
  const winningRule =
    routingRules.find((r) => r.serviceId === service.id) ??
    routingRules.find((r) => r.serviceId === null && r.locationId === null) ??
    null;
  const isAutoRouted = Boolean(
    winningRule && winningRule.enabled && winningRule.mode !== "manual" && !sp.staff
  );

  const accent = tenant.primaryColor;
  const showPoweredBy = !tenant.hidePoweredBy;
  const initials = staff.name
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const googleConnected = Boolean(staff.googleRefreshToken);

  // Parse specialties — schema stores as free-form text. Honest
  // approach: split on commas + trim, drop empties. Surface as
  // small chips (max 4) in the identity block.
  const specialtyChips = (staff.specialties ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 4);

  // Meeting platform display, derived from the service's
  // videoProvider column. "none" = in-person; absence = treat as
  // virtual (default video booking).
  const meeting = deriveMeetingMode(service.videoProvider);

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-b from-slate-50 via-white to-white">
      {/* Page-wide ambient depth (extremely subtle) */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 top-40 -z-10 h-[28rem] w-[28rem] rounded-full opacity-50 blur-[120px]"
        style={{ backgroundColor: accent, opacity: 0.06 }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 top-[28rem] -z-10 h-[24rem] w-[24rem] rounded-full bg-emerald-300/[0.04] blur-[120px]"
      />

      {/* Hero header */}
      <header className="relative border-b border-slate-200/70 bg-white/75 backdrop-blur-md">
        {/* Brand accent rule */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-[3px]"
          style={{
            background: `linear-gradient(to right, transparent, ${accent}, transparent)`,
          }}
        />

        <div className="relative mx-auto max-w-2xl px-6 py-9 sm:py-10">
          <Link
            href={`/u/${tenant.slug}`}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 transition-colors hover:text-slate-900"
          >
            <span aria-hidden>←</span> {tenant.name}
          </Link>

          {/* Step rail */}
          <nav className="mt-4 flex items-center gap-2 text-[11px]" aria-label="Booking progress">
            <span className="text-slate-400">1. Service</span>
            <span aria-hidden className="text-slate-300">›</span>
            <span className="font-semibold tracking-tight text-slate-900">2. Date &amp; time</span>
            <span aria-hidden className="text-slate-300">›</span>
            <span className="text-slate-400">3. Your details</span>
          </nav>

          <h1 className="mt-4 text-[26px] font-semibold tracking-tight text-slate-900 sm:text-[28px]">
            {service.name}
          </h1>
          {service.description && (
            <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-slate-600">
              {service.description}
            </p>
          )}

          {/* Service meta chips */}
          <div className="mt-5 flex flex-wrap items-center gap-2 text-[11.5px]">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 text-slate-500" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" strokeLinecap="round" />
              </svg>
              <span className="tabular-nums font-medium">{service.durationMinutes} min</span>
            </span>
            {service.price > 0 && (
              <span className="inline-flex items-center rounded-full border border-slate-200 bg-white/80 px-3 py-1 font-semibold text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                ${(service.price / 100).toFixed(0)}
              </span>
            )}
            {/* Meeting platform chip */}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
              <span aria-hidden className="text-slate-500" dangerouslySetInnerHTML={{ __html: meeting.iconSvg }} />
              {meeting.label}
            </span>
          </div>

          {/* Trust ribbon — calm, no marketing hype */}
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              Real-time availability
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckGlyph />
              Confirmed instantly
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckGlyph />
              Calendar invite included
            </span>
            <span className="inline-flex items-center gap-1.5" title="Your local timezone is detected automatically">
              <GlobeGlyph />
              Shown in your timezone
            </span>
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-2xl px-6 pb-16">
        {/* Staff identity block — premium humanized identity above the
            booking flow. Answers "who am I booking with?" directly. */}
        <StaffIdentityBlock
          name={staff.name}
          initials={initials}
          avatarUrl={staff.avatarUrl ?? null}
          departmentName={staff.departmentName ?? null}
          bio={staff.bio ?? null}
          specialtyChips={specialtyChips}
          googleConnected={googleConnected}
          accent={accent}
          isAutoRouted={isAutoRouted}
        />

        <BookingFlow
          serviceId={service.id}
          staffId={staff.userId}
          staffName={staff.name}
          durationMinutes={service.durationMinutes}
          accentColor={accent}
          tenantName={tenant.name}
          autoRouted={isAutoRouted}
          googleConnected={googleConnected}
        />

        {showPoweredBy && (
          <footer className="mt-12 border-t border-slate-200/70 pt-4 text-center text-[10.5px] tracking-wide text-slate-400">
            Powered by ZentroMeet
          </footer>
        )}
      </main>
    </div>
  );
}

/**
 * StaffIdentityBlock — humanized "who you're booking with" panel.
 *
 * Renders only fields that are backed by real data. Structurally
 * the component is extensible — when public profile fields land
 * (publicTitle, intro video, languages, reviews, etc.) they can
 * be added as additional rows without restructuring.
 */
function StaffIdentityBlock({
  name,
  initials,
  avatarUrl,
  departmentName,
  bio,
  specialtyChips,
  googleConnected,
  accent,
  isAutoRouted,
}: {
  name: string;
  initials: string;
  avatarUrl: string | null;
  departmentName: string | null;
  bio: string | null;
  specialtyChips: string[];
  googleConnected: boolean;
  accent: string;
  isAutoRouted: boolean;
}) {
  // When the booking is auto-routed, we're surfacing a generic
  // "next available specialist" experience rather than pinning a
  // specific person. Keep the block calm in that case.
  if (isAutoRouted) {
    return (
      <section className="mt-8 relative overflow-hidden rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_4px_18px_rgba(15,23,42,0.04)] sm:p-6">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />
        <div className="flex items-center gap-4">
          <div
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-white shadow-[0_4px_12px_rgba(15,23,42,0.10)]"
            style={{ backgroundColor: accent }}
            aria-hidden
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6" aria-hidden>
              <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em]" style={{ color: accent }}>
              You&rsquo;ll be matched
            </div>
            <h2 className="mt-0.5 text-[18px] font-semibold tracking-tight text-slate-900">
              Next available specialist
            </h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-slate-600">
              We&rsquo;ll route your booking to the right team member based on availability the moment you confirm.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-8 relative overflow-hidden rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_4px_18px_rgba(15,23,42,0.04)] sm:p-6">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent" />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
        {/* Avatar */}
        <div className="shrink-0">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt={name}
              className="h-16 w-16 rounded-2xl object-cover shadow-[0_4px_14px_rgba(15,23,42,0.10)] ring-2 ring-white sm:h-20 sm:w-20"
              loading="lazy"
            />
          ) : (
            <div
              className="flex h-16 w-16 items-center justify-center rounded-2xl text-[20px] font-semibold text-white shadow-[0_4px_14px_rgba(15,23,42,0.10)] ring-2 ring-white sm:h-20 sm:w-20"
              style={{ backgroundColor: accent }}
              aria-hidden
            >
              {initials || "?"}
            </div>
          )}
        </div>

        {/* Identity */}
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em]" style={{ color: accent }}>
            Your host
          </div>
          <h2 className="mt-0.5 text-[19px] font-semibold tracking-tight text-slate-900 sm:text-[20px]">
            {name}
          </h2>
          {departmentName && (
            <div className="mt-0.5 text-[13px] font-medium text-slate-600">
              {departmentName}
            </div>
          )}

          {bio && (
            <p className="mt-3 text-[13px] leading-relaxed text-slate-600">
              {bio}
            </p>
          )}

          {specialtyChips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {specialtyChips.map((s, i) => (
                <span
                  key={i}
                  className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50/70 px-2.5 py-0.5 text-[10.5px] font-medium text-slate-700"
                >
                  {s}
                </span>
              ))}
            </div>
          )}

          {/* Calendar-sync trust signal — only when the host has a
              real calendar connection. Honest signal, no fake. */}
          {googleConnected && (
            <div className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-emerald-700">
              <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              Real-time calendar sync
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function deriveMeetingMode(provider: string | null): {
  label: string;
  iconSvg: string;
} {
  // Inline SVG strings keep this entire helper self-contained in a
  // server component — no client-side icon library needed for the
  // server-rendered header.
  const videoIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3.5 w-3.5" aria-hidden="true"><path d="M23 7l-7 5 7 5V7zM14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" stroke-linejoin="round"/></svg>';
  const pinIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3.5 w-3.5" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" stroke-linejoin="round"/><circle cx="12" cy="10" r="3"/></svg>';
  switch (provider) {
    case "none":         return { label: "In-person",     iconSvg: pinIcon };
    case "google_meet":  return { label: "Google Meet",   iconSvg: videoIcon };
    case "zoom":         return { label: "Zoom",          iconSvg: videoIcon };
    case "teams":        return { label: "Microsoft Teams", iconSvg: videoIcon };
    default:             return { label: "Video meeting", iconSvg: videoIcon };
  }
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3 text-emerald-500" aria-hidden>
      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GlobeGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" strokeLinecap="round" />
    </svg>
  );
}

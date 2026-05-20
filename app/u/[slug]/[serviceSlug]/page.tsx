import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, isNull, or } from "drizzle-orm";

import { db } from "@/db/client";
import { serviceStaff, services, staffAssignmentRules, tenants, users } from "@/db/schema";
import BookingFlow from "@/components/BookingFlow";

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

  // Find a staff member who delivers this service. ?staff=<id> picks a
  // specific one; otherwise default to the first. Unchanged behavior —
  // Phase 10A is a UI-only luxury refinement pass.
  const assignments = await db
    .select({ userId: serviceStaff.userId, name: users.name })
    .from(serviceStaff)
    .innerJoin(users, eq(users.id, serviceStaff.userId))
    .where(and(
      eq(serviceStaff.serviceId, service.id),
      eq(serviceStaff.tenantId, tenant.id)
    ));
  if (assignments.length === 0) notFound();

  const staff = sp.staff
    ? assignments.find((a) => a.userId === sp.staff) ?? assignments[0]
    : assignments[0];

  // Routing intent — when a non-manual rule applies to this service or
  // the tenant default is non-manual, the booking is routed at insert
  // time by lib/routing/assignStaff. We surface that to the customer
  // here as "Next available specialist" instead of pinning a name.
  // The slots view continues to read from the preselected staff's
  // availability (additive — no change to lib/availability.ts).
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

          {/* Service meta chips — premium */}
          <div className="mt-5 flex flex-wrap items-center gap-2 text-[11.5px]">
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
            >
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
            <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-2.5 py-1 text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
              <span
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                style={{ backgroundColor: accent }}
                aria-hidden
              >
                {isAutoRouted ? "★" : initials || "?"}
              </span>
              {isAutoRouted ? (
                <span className="font-medium tracking-tight text-slate-900">Next available specialist</span>
              ) : (
                <>
                  with <span className="font-semibold tracking-tight text-slate-900">{staff.name}</span>
                </>
              )}
            </span>
          </div>

          {/* Trust ribbon — calm, no marketing hype */}
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              Live availability
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckGlyph />
              Confirmed instantly
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckGlyph />
              Calendar invite included
            </span>
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-2xl px-6 pb-16">
        <BookingFlow
          serviceId={service.id}
          staffId={staff.userId}
          staffName={staff.name}
          durationMinutes={service.durationMinutes}
          accentColor={accent}
          tenantName={tenant.name}
          autoRouted={isAutoRouted}
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

function CheckGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3 text-emerald-500" aria-hidden>
      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

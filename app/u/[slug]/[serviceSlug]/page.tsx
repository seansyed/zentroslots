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
  // this is a UI-only redesign pass.
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

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      {/* Glassy header bar — matches /u/[slug] landing */}
      <header
        className="border-b border-slate-200 bg-white/80 backdrop-blur"
        style={{ borderTop: `4px solid ${accent}` }}
      >
        <div className="mx-auto max-w-2xl px-6 py-8">
          <Link
            href={`/u/${tenant.slug}`}
            className="inline-flex items-center gap-1 text-xs text-slate-500 transition hover:text-slate-900"
          >
            ← {tenant.name}
          </Link>

          {/* Step indicator for context. The booking widget below owns the
              actual step state; this just orients the visitor. */}
          <nav className="mt-3 flex items-center gap-2 text-xs text-slate-400" aria-label="Booking progress">
            <span className="text-slate-400">1. Service</span>
            <span aria-hidden>›</span>
            <span className="font-semibold text-slate-900">2. Date &amp; time</span>
            <span aria-hidden>›</span>
            <span className="text-slate-400">3. Your details</span>
          </nav>

          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">{service.name}</h1>
          {service.description && (
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-slate-600">{service.description}</p>
          )}

          {/* Service meta chips */}
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/70 px-3 py-1 text-slate-600">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" strokeLinecap="round" />
              </svg>
              <span className="tabular-nums">{service.durationMinutes} min</span>
            </span>
            {service.price > 0 && (
              <span className="inline-flex items-center rounded-full border border-slate-200 bg-white/70 px-3 py-1 font-medium text-slate-700">
                ${(service.price / 100).toFixed(0)}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/70 px-3 py-1 text-slate-600">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden>
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
              </svg>
              {isAutoRouted ? (
                <span className="font-medium text-slate-900">Next available specialist</span>
              ) : (
                <>
                  with <span className="font-medium text-slate-900">{staff.name}</span>
                </>
              )}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-6 pb-16">
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
          <footer className="mt-10 border-t border-slate-200 pt-4 text-center text-[11px] text-slate-400">
            Powered by Scheduling SaaS
          </footer>
        )}
      </main>
    </div>
  );
}

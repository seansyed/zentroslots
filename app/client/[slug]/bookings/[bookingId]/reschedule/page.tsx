import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, users } from "@/db/schema";
import ClientPortalShell from "@/components/client/ClientPortalShell";
import { TimeText } from "@/components/client/TimeText";
import PortalReschedulePicker from "@/components/client/PortalReschedulePicker";
import { loadTenantFeatures } from "@/lib/features";
import { requireClientPortalContext } from "../../../_lib/guard";

export const dynamic = "force-dynamic";

/**
 * /client/[slug]/bookings/[bookingId]/reschedule
 *
 * Portal-authenticated reschedule page. Owns the booking summary +
 * tenant context server-side; the date strip + slot grid + submit
 * happen in the PortalReschedulePicker client component.
 *
 * Ownership chain:
 *   - requireClientPortalContext (tenant + session match)
 *   - Booking exists + tenant-scoped + clientEmail matches customer
 *   - Booking is reschedulable (not cancelled, not completed, in
 *     the future, tenant has "rescheduling" feature on)
 * Any failure → notFound(). The endpoint repeats every check, so
 * even a manually-crafted URL can't bypass.
 */
export default async function PortalReschedulePage(props: {
  params: Promise<{ slug: string; bookingId: string }>;
}) {
  const { slug, bookingId } = await props.params;
  const { tenant, customer, hasUnread } = await requireClientPortalContext(slug);

  // Tenant feature gate — if rescheduling is off, redirect back to the
  // bookings list rather than render a dead form. (The endpoint
  // independently 403s, but this avoids a confusing first paint.)
  const features = await loadTenantFeatures(tenant.id);
  if (!features.rescheduling) {
    redirect(`/client/${slug}/bookings`);
  }

  // Load booking + service + staff in one round-trip.
  const [row] = await db
    .select({
      bookingId: bookings.id,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      status: bookings.status,
      clientEmail: bookings.clientEmail,
      serviceId: services.id,
      serviceName: services.name,
      durationMinutes: services.durationMinutes,
      staffId: users.id,
      staffName: users.name,
      staffTimezone: users.timezone,
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .innerJoin(users, eq(users.id, bookings.staffUserId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenant.id)))
    .limit(1);

  if (!row) notFound();
  if (row.clientEmail.toLowerCase() !== customer.email.toLowerCase()) notFound();
  if (row.status === "cancelled" || row.status === "completed") notFound();
  // Past bookings can't be rescheduled — block at the page level too.
  if (row.startAt.getTime() < Date.now()) notFound();

  return (
    <ClientPortalShell
      tenant={{
        slug: tenant.slug,
        name: tenant.name,
        logoUrl: tenant.logoUrl,
        primaryColor: tenant.primaryColor,
        hidePoweredBy: tenant.hidePoweredBy,
      }}
      customer={{ name: customer.name, email: customer.email }}
      title="Reschedule appointment"
      hasUnread={hasUnread}
    >
      {/* Breadcrumb back to bookings */}
      <Link
        href={`/client/${tenant.slug}/bookings`}
        className="inline-flex items-center gap-1 text-[12px] font-medium text-slate-500 transition-colors hover:text-slate-900"
      >
        <span aria-hidden>←</span> Back to bookings
      </Link>

      {/* Current appointment summary */}
      <section className="relative mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent"
        />
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
          Current appointment
        </div>
        <div className="mt-3 flex items-start gap-3">
          <div
            className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl text-white shadow-[0_4px_12px_rgba(15,23,42,0.10)]"
            style={{ backgroundColor: tenant.primaryColor }}
            aria-hidden
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider opacity-90">
              <TimeText iso={row.startAt.toISOString()} format="MMM" />
            </span>
            <span className="text-base font-semibold leading-none">
              <TimeText iso={row.startAt.toISOString()} format="d" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold tracking-tight text-slate-900">
              {row.serviceName}
            </div>
            <div className="text-[12px] text-slate-500">
              <TimeText iso={row.startAt.toISOString()} format="EEE, MMM d · h:mm a" />
              {" · "}{row.durationMinutes} min{" · "}
              with <span className="font-medium text-slate-700">{row.staffName}</span>
            </div>
          </div>
        </div>
      </section>

      <PortalReschedulePicker
        tenantSlug={tenant.slug}
        bookingId={row.bookingId}
        serviceId={row.serviceId}
        staffId={row.staffId}
        staffName={row.staffName}
        staffTimezone={row.staffTimezone}
        durationMinutes={row.durationMinutes}
        accent={tenant.primaryColor}
      />
    </ClientPortalShell>
  );
}

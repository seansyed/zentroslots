import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, users } from "@/db/schema";
import ClientPortalShell from "@/components/client/ClientPortalShell";
import { signBookingToken } from "@/lib/tokens";
import { requireClientPortalContext } from "../_lib/guard";

export const dynamic = "force-dynamic";

export default async function ClientBookingsPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const { tenant, customer } = await requireClientPortalContext(slug);

  const rows = await db
    .select({
      id: bookings.id,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      status: bookings.status,
      meetLink: bookings.meetLink,
      notes: bookings.notes,
      serviceName: services.name,
      serviceSlug: services.slug,
      durationMinutes: services.durationMinutes,
      staffUserId: users.id,
      staffName: users.name,
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .innerJoin(users, eq(users.id, bookings.staffUserId))
    .where(and(eq(bookings.tenantId, tenant.id), eq(bookings.clientEmail, customer.email)))
    .orderBy(desc(bookings.startAt))
    .limit(200);

  const now = Date.now();
  const upcoming = rows.filter((r) => r.startAt.getTime() >= now && r.status !== "cancelled");
  const past = rows.filter((r) => !(r.startAt.getTime() >= now && r.status !== "cancelled"));

  // Mint cancel/reschedule tokens for upcoming rows so the buttons hit
  // the existing token-gated public endpoints.
  const upcomingWithTokens = await Promise.all(
    upcoming.map(async (b) => ({
      ...b,
      cancelToken: await signBookingToken({ bookingId: b.id, tenantId: tenant.id, kind: "cancel" }),
      rescheduleToken: await signBookingToken({ bookingId: b.id, tenantId: tenant.id, kind: "reschedule" }),
    }))
  );

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
      title="Bookings"
    >
      <section className="space-y-4">
        <SectionHeader label={`Upcoming (${upcomingWithTokens.length})`} />
        {upcomingWithTokens.length === 0 ? (
          <EmptyCard>
            Nothing upcoming.{" "}
            <Link href={`/u/${tenant.slug}`} className="font-medium underline" style={{ color: tenant.primaryColor }}>
              Book a new appointment
            </Link>
            .
          </EmptyCard>
        ) : (
          <ul className="space-y-3">
            {upcomingWithTokens.map((b) => (
              <BookingCard
                key={b.id}
                booking={{
                  ...b,
                  startAt: b.startAt.toISOString(),
                  endAt: b.endAt.toISOString(),
                }}
                accent={tenant.primaryColor}
                tenantSlug={tenant.slug}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8 space-y-4">
        <SectionHeader label={`Past (${past.length})`} />
        {past.length === 0 ? (
          <EmptyCard>No past appointments yet.</EmptyCard>
        ) : (
          <ul className="space-y-3">
            {past.map((b) => (
              <BookingCard
                key={b.id}
                booking={{
                  ...b,
                  startAt: b.startAt.toISOString(),
                  endAt: b.endAt.toISOString(),
                  cancelToken: undefined,
                  rescheduleToken: undefined,
                }}
                accent={tenant.primaryColor}
                tenantSlug={tenant.slug}
                past
              />
            ))}
          </ul>
        )}
      </section>
    </ClientPortalShell>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
      {children}
    </div>
  );
}

function BookingCard({
  booking,
  accent,
  tenantSlug,
  past = false,
}: {
  booking: {
    id: string;
    startAt: string;
    endAt: string;
    status: string;
    meetLink: string | null;
    notes: string | null;
    serviceName: string;
    serviceSlug: string;
    durationMinutes: number;
    staffUserId: string;
    staffName: string;
    cancelToken?: string;
    rescheduleToken?: string;
  };
  accent: string;
  tenantSlug: string;
  past?: boolean;
}) {
  const start = new Date(booking.startAt);
  return (
    <li className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${past ? "opacity-90" : ""}`}>
      <div className="flex items-start gap-3">
        <div
          className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-lg text-white"
          style={{ backgroundColor: accent }}
          aria-hidden
        >
          <span className="text-[10px] font-semibold uppercase tracking-wider opacity-80">
            {start.toUTCString().slice(8, 11)}
          </span>
          <span className="text-base font-semibold leading-none">
            {start.toUTCString().slice(5, 7)}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900">{booking.serviceName}</div>
              <div className="text-xs text-slate-500">
                {start.toUTCString().slice(0, 22)} · {booking.durationMinutes} min · with {booking.staffName}
              </div>
            </div>
            <StatusBadge status={booking.status} />
          </div>
          {booking.notes && (
            <div className="mt-2 rounded-md bg-slate-50 p-2 text-xs text-slate-600">{booking.notes}</div>
          )}
          {!past && (
            <div className="mt-3 flex flex-wrap gap-2">
              {booking.meetLink && (
                <a
                  href={booking.meetLink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:opacity-90"
                  style={{ backgroundColor: accent }}
                >
                  Join meeting
                </a>
              )}
              {booking.rescheduleToken && (
                <Link
                  href={`/reschedule/${encodeURIComponent(booking.rescheduleToken)}`}
                  className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
                >
                  Reschedule
                </Link>
              )}
              {booking.cancelToken && (
                <Link
                  href={`/cancel/${encodeURIComponent(booking.cancelToken)}`}
                  className="inline-flex items-center justify-center rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 shadow-sm transition hover:bg-red-50"
                >
                  Cancel
                </Link>
              )}
            </div>
          )}
          {past && booking.status !== "cancelled" && (
            <div className="mt-3">
              <Link
                href={`/u/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(booking.serviceSlug)}?staff=${encodeURIComponent(booking.staffUserId)}`}
                className="inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:opacity-90"
                style={{ backgroundColor: accent }}
              >
                ↻ Book again
              </Link>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    confirmed: "bg-green-100 text-green-800",
    pending: "bg-amber-100 text-amber-800",
    cancelled: "bg-red-100 text-red-700",
    completed: "bg-blue-100 text-blue-800",
    no_show: "bg-red-100 text-red-700",
  };
  const cls = colors[status] ?? "bg-slate-100 text-slate-700";
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>
      {status.replace("_", " ")}
    </span>
  );
}

import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, users } from "@/db/schema";
import ClientPortalShell from "@/components/client/ClientPortalShell";
import { TimeText } from "@/components/client/TimeText";
import { loadTenantFeatures } from "@/lib/features";
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

  // Tenant feature gate — see lib/features.ts. Only mint reschedule/cancel
  // tokens when the workspace has those features enabled. The public
  // token-gated routes also independently 403 if disabled, so this is
  // defense in depth.
  const features = await loadTenantFeatures(tenant.id);

  const upcomingWithTokens = await Promise.all(
    upcoming.map(async (b) => ({
      ...b,
      cancelToken: features.cancellations
        ? await signBookingToken({ bookingId: b.id, tenantId: tenant.id, kind: "cancel" })
        : undefined,
      rescheduleToken: features.rescheduling
        ? await signBookingToken({ bookingId: b.id, tenantId: tenant.id, kind: "reschedule" })
        : undefined,
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
        <SectionHeader label="Upcoming" count={upcomingWithTokens.length} />
        {upcomingWithTokens.length === 0 ? (
          <PortalEmptyCard
            iconKind="calendar"
            title="No upcoming appointments"
            body="Book a new appointment and it'll show up here."
            ctaHref={`/u/${tenant.slug}`}
            ctaLabel="Book a new appointment"
            accent={tenant.primaryColor}
          />
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
        <SectionHeader label="Past" count={past.length} />
        {past.length === 0 ? (
          <PortalEmptyCard
            iconKind="history"
            title="No past appointments yet"
            body="Once you've completed a booking, you'll see it here."
            accent={tenant.primaryColor}
          />
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

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
        {label}
      </div>
      <div className="text-[11px] tabular-nums text-slate-400">
        {count} {count === 1 ? "appointment" : "appointments"}
      </div>
    </div>
  );
}

function PortalEmptyCard({
  iconKind,
  title,
  body,
  ctaHref,
  ctaLabel,
  accent,
}: {
  iconKind: "calendar" | "history";
  title: string;
  body: string;
  ctaHref?: string;
  ctaLabel?: string;
  accent: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-dashed border-slate-300 bg-gradient-to-br from-slate-50/70 to-white p-7 text-center shadow-sm">
      <div
        className="mx-auto inline-flex h-11 w-11 items-center justify-center rounded-xl bg-white text-slate-400 shadow-sm ring-1 ring-slate-200"
        aria-hidden
      >
        {iconKind === "calendar" ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" strokeLinecap="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
            <path d="M3 12a9 9 0 1 0 3-6.7M3 3v6h6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <div className="mt-3 text-[13.5px] font-semibold text-slate-900">{title}</div>
      <p className="mt-1 text-[12px] leading-relaxed text-slate-500">{body}</p>
      {ctaHref && ctaLabel && (
        <Link
          href={ctaHref}
          className="mt-4 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
          style={{ backgroundColor: accent }}
        >
          {ctaLabel}
          <span aria-hidden>→</span>
        </Link>
      )}
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
  return (
    <li
      className={
        "relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md" +
        (past ? " opacity-90" : "")
      }
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl text-white shadow-[0_4px_12px_rgba(15,23,42,0.10)]"
          style={{ backgroundColor: accent }}
          aria-hidden
        >
          <span className="text-[10px] font-semibold uppercase tracking-wider opacity-90">
            <TimeText iso={booking.startAt} format="MMM" />
          </span>
          <span className="text-base font-semibold leading-none">
            <TimeText iso={booking.startAt} format="d" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold tracking-tight text-slate-900">
                {booking.serviceName}
              </div>
              <div className="text-[12px] text-slate-500">
                <TimeText iso={booking.startAt} format="EEE, MMM d · h:mm a" />
                {" · "}
                {booking.durationMinutes} min
                {" · "}
                with <span className="font-medium text-slate-700">{booking.staffName}</span>
              </div>
            </div>
            <StatusBadge status={booking.status} />
          </div>
          {booking.notes && (
            <div className="mt-2 rounded-md bg-slate-50 p-2 text-[12px] text-slate-600 ring-1 ring-slate-100">
              {booking.notes}
            </div>
          )}
          {!past && (
            <div className="mt-3 flex flex-wrap gap-2">
              {booking.meetLink && (
                <a
                  href={booking.meetLink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
                  style={{ backgroundColor: accent }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden>
                    <path d="M23 7l-7 5 7 5V7zM14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" strokeLinejoin="round" />
                  </svg>
                  Join meeting
                </a>
              )}
              {booking.rescheduleToken && (
                <Link
                  href={`/reschedule/${encodeURIComponent(booking.rescheduleToken)}`}
                  className="inline-flex min-h-[36px] items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-sm"
                >
                  Reschedule
                </Link>
              )}
              {booking.cancelToken && (
                <Link
                  href={`/cancel/${encodeURIComponent(booking.cancelToken)}`}
                  className="inline-flex min-h-[36px] items-center justify-center rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-[12px] font-medium text-rose-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-rose-50 hover:shadow-sm"
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
                className="inline-flex min-h-[36px] items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
                style={{ backgroundColor: accent }}
              >
                <span aria-hidden>↻</span> Book again
              </Link>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function StatusBadge({ status }: { status: string }) {
  // Phase 18 — refined status pill: tonal background + matching dot.
  const pills: Record<string, { bg: string; text: string; dot: string }> = {
    confirmed: { bg: "bg-emerald-50",  text: "text-emerald-700",  dot: "bg-emerald-500" },
    pending:   { bg: "bg-amber-50",    text: "text-amber-700",    dot: "bg-amber-500" },
    cancelled: { bg: "bg-rose-50",     text: "text-rose-700",     dot: "bg-rose-500" },
    completed: { bg: "bg-sky-50",      text: "text-sky-700",      dot: "bg-sky-500" },
    no_show:   { bg: "bg-rose-50",     text: "text-rose-700",     dot: "bg-rose-500" },
  };
  const s = pills[status] ?? { bg: "bg-slate-100", text: "text-slate-700", dot: "bg-slate-400" };
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full ${s.bg} px-2 py-0.5 text-[10px] font-medium ${s.text}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {status.replace("_", " ")}
    </span>
  );
}

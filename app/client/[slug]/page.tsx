import Link from "next/link";
import { and, desc, eq, gte } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, users } from "@/db/schema";
import ClientPortalShell from "@/components/client/ClientPortalShell";
import { TimeText } from "@/components/client/TimeText";
import { requireClientPortalContext } from "./_lib/guard";

export const dynamic = "force-dynamic";

export default async function ClientHomePage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const { tenant, customer } = await requireClientPortalContext(slug);

  const now = new Date();
  // Match bookings to this customer by email-equality fallback — older
  // bookings may pre-date the customer FK being established.
  const next = await db
    .select({
      id: bookings.id,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      status: bookings.status,
      meetLink: bookings.meetLink,
      serviceName: services.name,
      staffName: users.name,
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .innerJoin(users, eq(users.id, bookings.staffUserId))
    .where(
      and(
        eq(bookings.tenantId, tenant.id),
        eq(bookings.clientEmail, customer.email),
        eq(bookings.status, "confirmed"),
        gte(bookings.startAt, now)
      )
    )
    .orderBy(bookings.startAt)
    .limit(1);

  const recent = await db
    .select({
      id: bookings.id,
      startAt: bookings.startAt,
      status: bookings.status,
      serviceName: services.name,
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .where(and(eq(bookings.tenantId, tenant.id), eq(bookings.clientEmail, customer.email)))
    .orderBy(desc(bookings.startAt))
    .limit(5);

  const firstName = customer.name.split(" ")[0] || "there";

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
      title={`Welcome back, ${firstName}`}
    >
      {/* Next-up card */}
      <section className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent"
        />
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
          Your next appointment
        </div>
        {next.length === 0 ? (
          <PortalEmptyCard
            tenantSlug={tenant.slug}
            accent={tenant.primaryColor}
          />
        ) : (
          <NextAppointmentCard
            booking={{
              id: next[0].id,
              startAt: next[0].startAt.toISOString(),
              endAt: next[0].endAt.toISOString(),
              status: next[0].status,
              meetLink: next[0].meetLink,
              serviceName: next[0].serviceName,
              staffName: next[0].staffName,
            }}
            accent={tenant.primaryColor}
          />
        )}
      </section>

      {/* Quick actions */}
      <section className="mt-5 grid gap-3 sm:grid-cols-2">
        <Link
          href={`/u/${tenant.slug}`}
          className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
        >
          <div className="flex items-start gap-3">
            <div
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white shadow-sm transition-transform duration-200 group-hover:scale-105"
              style={{ backgroundColor: tenant.primaryColor }}
              aria-hidden
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path d="M16 2v4M8 2v4M3 10h18M12 14v4M10 16h4" strokeLinecap="round" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900">Book another appointment</div>
              <div className="mt-0.5 text-[12px] text-slate-500">Browse services and times</div>
            </div>
          </div>
        </Link>
        <Link
          href={`/client/${tenant.slug}/bookings`}
          className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
        >
          <div className="flex items-start gap-3">
            <div
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white shadow-sm transition-transform duration-200 group-hover:scale-105"
              style={{ backgroundColor: tenant.primaryColor }}
              aria-hidden
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
              </svg>
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900">View all bookings</div>
              <div className="mt-0.5 text-[12px] text-slate-500">Past + upcoming</div>
            </div>
          </div>
        </Link>
      </section>

      {/* Recent activity */}
      <section className="relative mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent"
        />
        <div className="flex items-baseline justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
            Recent
          </div>
          <Link
            href={`/client/${tenant.slug}/bookings`}
            className="text-[11.5px] font-medium text-slate-500 transition hover:text-slate-900"
          >
            View all →
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="mt-3 text-sm text-slate-500">No history yet.</div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {recent.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-slate-900">{r.serviceName}</div>
                  <div className="text-[11.5px] text-slate-500">
                    <TimeText iso={r.startAt.toISOString()} format="MMM d, yyyy" />
                  </div>
                </div>
                <StatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </ClientPortalShell>
  );
}

function NextAppointmentCard({
  booking,
  accent,
}: {
  booking: {
    id: string;
    startAt: string;
    endAt: string;
    status: string;
    meetLink: string | null;
    serviceName: string;
    staffName: string;
  };
  accent: string;
}) {
  return (
    <div
      className="mt-3 flex flex-col gap-4 rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50/80 via-white to-white p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] sm:flex-row sm:items-center"
    >
      <div
        className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl text-white shadow-[0_4px_12px_rgba(15,23,42,0.10)]"
        style={{ backgroundColor: accent }}
        aria-hidden
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider opacity-90">
          <TimeText iso={booking.startAt} format="MMM" />
        </span>
        <span className="text-xl font-semibold leading-none">
          <TimeText iso={booking.startAt} format="d" />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-base font-semibold tracking-tight text-slate-900">
          {booking.serviceName}
        </div>
        <div className="mt-0.5 text-sm text-slate-600">
          <TimeText iso={booking.startAt} format="EEEE · h:mm a" />
        </div>
        <div className="mt-0.5 text-[12px] text-slate-500">
          with <span className="font-medium text-slate-700">{booking.staffName}</span>
        </div>
      </div>
      {booking.meetLink && (
        <a
          href={booking.meetLink}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12.5px] font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          style={{ backgroundColor: accent }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden>
            <path d="M23 7l-7 5 7 5V7zM14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" strokeLinejoin="round" />
          </svg>
          Join meeting
        </a>
      )}
    </div>
  );
}

function PortalEmptyCard({
  tenantSlug,
  accent,
}: {
  tenantSlug: string;
  accent: string;
}) {
  return (
    <div className="relative mt-3 overflow-hidden rounded-xl border border-dashed border-slate-300 bg-gradient-to-br from-slate-50/70 to-white p-6 text-center">
      <div
        className="mx-auto inline-flex h-10 w-10 items-center justify-center rounded-xl bg-white text-slate-400 shadow-sm ring-1 ring-slate-200"
        aria-hidden
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" strokeLinecap="round" />
        </svg>
      </div>
      <div className="mt-2.5 text-[13.5px] font-medium text-slate-700">Nothing on the books</div>
      <p className="mt-1 text-[11.5px] text-slate-500">
        Book a new appointment and it&rsquo;ll appear here.
      </p>
      <Link
        href={`/u/${tenantSlug}`}
        className="mt-4 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
        style={{ backgroundColor: accent }}
      >
        Book a new appointment
        <span aria-hidden>→</span>
      </Link>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  // Phase 18 — refined status pill: tonal background + matching dot,
  // tighter typography. Less "stoplight," more "calm operational."
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

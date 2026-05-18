import Link from "next/link";
import { and, desc, eq, gte } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, users } from "@/db/schema";
import ClientPortalShell from "@/components/client/ClientPortalShell";
import { requireClientPortalContext } from "./_lib/guard";

export const dynamic = "force-dynamic";

export default async function ClientHomePage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const { tenant, customer } = await requireClientPortalContext(slug);

  const now = new Date();
  // Match bookings to this customer by both customer_id link AND
  // email-equality fallback — older bookings may pre-date the customer
  // record being established and only carry the client_email field.
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
      title={`Hi, ${customer.name.split(" ")[0] || "there"}`}
    >
      {/* Next-up card */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Your next appointment
        </div>
        {next.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
            Nothing on the books.
            <div className="mt-2">
              <Link
                href={`/u/${tenant.slug}`}
                className="inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:opacity-90"
                style={{ backgroundColor: tenant.primaryColor }}
              >
                Book a new appointment →
              </Link>
            </div>
          </div>
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
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow"
        >
          <div className="text-sm font-medium text-slate-900">Book another appointment</div>
          <div className="mt-0.5 text-xs text-slate-500">Browse services and times</div>
        </Link>
        <Link
          href={`/client/${tenant.slug}/bookings`}
          className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow"
        >
          <div className="text-sm font-medium text-slate-900">View all bookings</div>
          <div className="mt-0.5 text-xs text-slate-500">Past + upcoming</div>
        </Link>
      </section>

      {/* Recent activity */}
      <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-baseline justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Recent
          </div>
          <Link href={`/client/${tenant.slug}/bookings`} className="text-xs text-slate-500 hover:text-slate-900">
            View all →
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="mt-3 text-sm text-slate-500">No history yet.</div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 text-sm">
            {recent.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-slate-900">{r.serviceName}</div>
                  <div className="text-xs text-slate-500">
                    {r.startAt.toISOString().slice(0, 10)}
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
  const start = new Date(booking.startAt);
  const date = start.toUTCString().slice(0, 16); // e.g. "Mon, 19 May 2026"
  const time = start.toUTCString().slice(17, 22); // "HH:MM"
  return (
    <div className="mt-3 flex flex-col gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center">
      <div
        className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl text-white"
        style={{ backgroundColor: accent }}
        aria-hidden
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider opacity-80">
          {start.toUTCString().slice(8, 11)}
        </span>
        <span className="text-xl font-semibold leading-none">
          {start.toUTCString().slice(5, 7)}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-base font-semibold text-slate-900">{booking.serviceName}</div>
        <div className="mt-0.5 text-sm text-slate-600">
          {date} · {time} UTC
        </div>
        <div className="mt-0.5 text-xs text-slate-500">with {booking.staffName}</div>
      </div>
      {booking.meetLink && (
        <a
          href={booking.meetLink}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:opacity-90"
          style={{ backgroundColor: accent }}
        >
          Join meeting
        </a>
      )}
    </div>
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

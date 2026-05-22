import Link from "next/link";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookingOccurrences, bookingSeries, bookings, services, users, waitlists } from "@/db/schema";
import ClientPortalShell from "@/components/client/ClientPortalShell";
import { TimeText } from "@/components/client/TimeText";
import { summarizeRRule } from "@/lib/recurrence-summary";
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

  // ── F9 Recurring-series visibility ───────────────────────────────
  // Surface every active series owned by this customer's email along
  // with the next few materialized occurrences. Customers who never
  // joined a recurring series see an empty array → section hides.
  const activeSeries = await db
    .select({
      id: bookingSeries.id,
      recurrenceRule: bookingSeries.recurrenceRule,
      occurrenceCount: bookingSeries.occurrenceCount,
      endDate: bookingSeries.endDate,
      serviceName: services.name,
      staffName: users.name,
    })
    .from(bookingSeries)
    .innerJoin(services, eq(services.id, bookingSeries.serviceId))
    .leftJoin(users, eq(users.id, bookingSeries.staffUserId))
    .where(
      and(
        eq(bookingSeries.tenantId, tenant.id),
        sql`lower(${bookingSeries.customerEmail}) = ${customer.email.toLowerCase()}`,
        eq(bookingSeries.status, "active"),
      ),
    )
    .orderBy(asc(bookingSeries.createdAt))
    .limit(3);

  const seriesWithUpcoming = await Promise.all(
    activeSeries.map(async (s) => {
      const upcoming = await db
        .select({
          id: bookingOccurrences.id,
          startAt: bookingOccurrences.occurrenceStartAt,
          status: bookingOccurrences.status,
        })
        .from(bookingOccurrences)
        .where(
          and(
            eq(bookingOccurrences.bookingSeriesId, s.id),
            eq(bookingOccurrences.status, "scheduled"),
            gte(bookingOccurrences.occurrenceStartAt, now),
          ),
        )
        .orderBy(asc(bookingOccurrences.occurrenceStartAt))
        .limit(3);
      return { ...s, upcoming };
    }),
  );

  // ── F10 Waitlist queue position ──────────────────────────────────
  // Find every waiting entry for this customer. Then compute each
  // entry's queue position via a SQL count of waiting peers with
  // higher priority or earlier created_at (the same ordering the
  // waitlist engine uses to promote). One round-trip per entry — fine
  // for the typical 0–2 entries per customer; capped at 5.
  const activeWaits = await db
    .select({
      id: waitlists.id,
      serviceId: waitlists.serviceId,
      priority: waitlists.priority,
      createdAt: waitlists.createdAt,
      preferredDate: waitlists.preferredDate,
      preferredTimeRange: waitlists.preferredTimeRange,
      serviceName: services.name,
    })
    .from(waitlists)
    .innerJoin(services, eq(services.id, waitlists.serviceId))
    .where(
      and(
        eq(waitlists.tenantId, tenant.id),
        sql`lower(${waitlists.customerEmail}) = ${customer.email.toLowerCase()}`,
        eq(waitlists.status, "waiting"),
      ),
    )
    .orderBy(asc(waitlists.createdAt))
    .limit(5);

  const waitsWithPosition = await Promise.all(
    activeWaits.map(async (w) => {
      const [row] = await db.execute<{ ahead: number }>(sql`
        SELECT COUNT(*)::int AS ahead
          FROM ${waitlists}
         WHERE ${waitlists.tenantId} = ${tenant.id}
           AND ${waitlists.serviceId} = ${w.serviceId}
           AND ${waitlists.status} = 'waiting'
           AND (
             ${waitlists.priority} > ${w.priority}
             OR (${waitlists.priority} = ${w.priority} AND ${waitlists.createdAt} < ${w.createdAt})
           )
      `);
      const ahead = Number(row?.ahead ?? 0);
      return { ...w, position: ahead + 1 };
    }),
  );

  // ── F12 History intelligence ─────────────────────────────────────
  // Single aggregate over the customer's lifetime bookings. Counts +
  // total minutes-actually-attended (completed only — no_show + cancel
  // didn't consume any time). The attendance rate excludes cancellations
  // since those were never expected to happen — it's the conventional
  // "show-up rate" = completed / (completed + no_show).
  const [historyRow] = await db.execute<{
    completed: number;
    no_show: number;
    cancelled: number;
    total_minutes: number;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE ${bookings.status} = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE ${bookings.status} = 'no_show')::int   AS no_show,
      COUNT(*) FILTER (WHERE ${bookings.status} = 'cancelled')::int AS cancelled,
      COALESCE(
        SUM(EXTRACT(EPOCH FROM (${bookings.endAt} - ${bookings.startAt})) / 60)
          FILTER (WHERE ${bookings.status} = 'completed'),
        0
      )::int AS total_minutes
    FROM ${bookings}
    WHERE ${bookings.tenantId} = ${tenant.id}
      AND lower(${bookings.clientEmail}) = ${customer.email.toLowerCase()}
  `);

  const historyCompleted = Number(historyRow?.completed ?? 0);
  const historyNoShow = Number(historyRow?.no_show ?? 0);
  const historyMinutes = Number(historyRow?.total_minutes ?? 0);
  const historyShowDenominator = historyCompleted + historyNoShow;
  const historyAttendancePct = historyShowDenominator > 0
    ? Math.round((historyCompleted / historyShowDenominator) * 100)
    : null;

  // Most-booked service (lifetime, completed status). Skipped when
  // history is empty — the whole F12 section hides in that case.
  let mostBookedService: { name: string; count: number } | null = null;
  if (historyCompleted > 0) {
    const top = await db
      .select({
        name: services.name,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(bookings)
      .innerJoin(services, eq(services.id, bookings.serviceId))
      .where(
        and(
          eq(bookings.tenantId, tenant.id),
          sql`lower(${bookings.clientEmail}) = ${customer.email.toLowerCase()}`,
          eq(bookings.status, "completed"),
        ),
      )
      .groupBy(services.id, services.name)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(1);
    if (top.length > 0) {
      mostBookedService = { name: top[0].name, count: Number(top[0].count) };
    }
  }

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

      {/* F9 — Recurring series. Only rendered when the customer is on
          at least one active series. The booking_series engine already
          materializes occurrences into the bookings table, so this is
          purely a visibility layer — no behavior change. */}
      {seriesWithUpcoming.length > 0 && (
        <section className="relative mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent"
          />
          <div className="flex items-baseline justify-between">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
              Your recurring schedule
            </div>
            <Link
              href={`/client/${tenant.slug}/bookings`}
              className="text-[11.5px] font-medium text-slate-500 transition hover:text-slate-900"
            >
              View all →
            </Link>
          </div>
          <ul className="mt-3 space-y-3">
            {seriesWithUpcoming.map((s) => (
              <li
                key={s.id}
                className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50/70 to-white p-3.5"
              >
                <div className="flex items-start gap-3">
                  <div
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white shadow-sm"
                    style={{ backgroundColor: tenant.primaryColor }}
                    aria-hidden
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                      <path d="M3 12a9 9 0 1 0 3-6.7M3 3v6h6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-semibold tracking-tight text-slate-900">
                      {s.serviceName}
                      {s.staffName && (
                        <span className="font-normal text-slate-500"> · with {s.staffName}</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-slate-500">
                      <span className="font-medium text-slate-700">{summarizeRRule(s.recurrenceRule)}</span>
                      {s.occurrenceCount ? (
                        <> · {s.occurrenceCount} total</>
                      ) : null}
                      {s.endDate ? (
                        <> · ends <TimeText iso={new Date(s.endDate + "T00:00:00").toISOString()} format="MMM d" /></>
                      ) : null}
                    </div>
                    {s.upcoming.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {s.upcoming.map((o) => (
                          <span
                            key={o.id}
                            className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-0.5 text-[10.5px] font-medium tabular-nums text-slate-700 ring-1 ring-slate-200"
                          >
                            <TimeText iso={o.startAt.toISOString()} format="MMM d · h:mm a" />
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 text-[10.5px] text-slate-400">
                        Upcoming occurrences will appear here.
                      </div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* F10 — Waitlist queue position. Surfaces every active waiting
          entry for this customer with the live queue position. Cap at 5
          entries (the per-customer SLO most tenants never approach). */}
      {waitsWithPosition.length > 0 && (
        <section className="relative mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent"
          />
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
            On the waitlist
          </div>
          <ul className="mt-3 space-y-2.5">
            {waitsWithPosition.map((w) => (
              <li
                key={w.id}
                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-gradient-to-br from-amber-50/40 to-white p-3"
              >
                <div
                  className="inline-flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg text-white shadow-sm"
                  style={{ backgroundColor: tenant.primaryColor }}
                  aria-hidden
                >
                  <span className="text-[9px] font-semibold uppercase tracking-wider opacity-90">Pos</span>
                  <span className="text-[14px] font-semibold leading-none tabular-nums">{w.position}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-semibold tracking-tight text-slate-900">
                    {w.serviceName}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-slate-500">
                    {w.preferredDate ? (
                      <>
                        Preferred:{" "}
                        <TimeText
                          iso={new Date(w.preferredDate + "T12:00:00").toISOString()}
                          format="MMM d"
                        />
                        {w.preferredTimeRange !== "any" && <> · {w.preferredTimeRange}</>}
                        {" · "}
                      </>
                    ) : null}
                    We&rsquo;ll email instantly if a slot opens.
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

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

      {/* F12 — History intelligence. Lifetime stats card rendered only
          when the customer has at least one completed booking. Pure
          aggregate over existing bookings — no schema, no new state. */}
      {historyCompleted > 0 && (
        <section className="relative mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent"
          />
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
            Your history with {tenant.name}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <HistoryStat
              label="Sessions completed"
              value={historyCompleted.toLocaleString()}
              accent={tenant.primaryColor}
            />
            <HistoryStat
              label="Time with us"
              value={formatDurationMinutes(historyMinutes)}
              accent={tenant.primaryColor}
            />
            {historyAttendancePct !== null && (
              <HistoryStat
                label="Attendance"
                value={`${historyAttendancePct}%`}
                accent={tenant.primaryColor}
              />
            )}
          </div>
          {mostBookedService && (
            <div className="mt-3 text-[11.5px] text-slate-500">
              Most-booked service:{" "}
              <span className="font-medium text-slate-700">{mostBookedService.name}</span>
              {" · "}
              <span className="tabular-nums">{mostBookedService.count}×</span>
            </div>
          )}
        </section>
      )}

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

function HistoryStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50/70 to-white p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
        {label}
      </div>
      <div
        className="mt-1 text-[20px] font-semibold leading-none tracking-tight tabular-nums"
        style={{ color: accent }}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Formats a minute count as a calm, customer-facing duration string.
 *   < 60 min  → "45 min"
 *   < 24 hr   → "3h 15m" / "3h"
 *   ≥ 24 hr   → "12h 30m" (we don't bucket into days — "1d 3h" reads
 *                          less naturally for "time spent with a host")
 */
function formatDurationMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
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

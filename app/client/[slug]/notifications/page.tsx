import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { auditLogs, bookings, services } from "@/db/schema";
import ClientPortalShell from "@/components/client/ClientPortalShell";
import { requireClientPortalContext } from "../_lib/guard";

export const dynamic = "force-dynamic";

// Notifications are derived from existing audit_logs scoped to this
// customer's bookings. We don't introduce a per-client read-state table
// yet — that's a separate session. The page surfaces the events that
// matter to a client: booking lifecycle changes and emails sent about
// their bookings.

const RELEVANT_ACTIONS = [
  "booking.create",
  "booking.cancel",
  "booking.reschedule",
  "email.sent",
  "email.failed",
] as const;

export default async function ClientNotificationsPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const { tenant, customer } = await requireClientPortalContext(slug);

  // Find every booking owned by this customer's email. We use email
  // (not customer_id) because older bookings may pre-date the customer
  // FK being established.
  const ownedBookings = await db
    .select({
      id: bookings.id,
      startAt: bookings.startAt,
      serviceName: services.name,
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .where(and(eq(bookings.tenantId, tenant.id), eq(bookings.clientEmail, customer.email)));

  const bookingById = new Map(ownedBookings.map((b) => [b.id, b]));

  const events = ownedBookings.length === 0
    ? []
    : await db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          entityId: auditLogs.entityId,
          metadata: auditLogs.metadata,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.tenantId, tenant.id),
            eq(auditLogs.entityType, "booking"),
            inArray(auditLogs.entityId, ownedBookings.map((b) => b.id)),
            inArray(auditLogs.action, RELEVANT_ACTIONS as unknown as string[])
          )
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(100);

  const groups = groupByDay(
    events.map((e) => ({
      ...e,
      booking: e.entityId ? bookingById.get(e.entityId) ?? null : null,
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
      title="Notifications"
    >
      {events.length === 0 ? (
        <EmptyState accent={tenant.primaryColor} />
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.label}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {g.label}
              </div>
              <ul className="mt-2 space-y-2">
                {g.entries.map((e) => (
                  <NotificationCard key={e.id} entry={e} accent={tenant.primaryColor} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </ClientPortalShell>
  );
}

// ─── Components ────────────────────────────────────────────────────────

type EntryWithBooking = {
  id: string;
  action: string;
  entityId: string | null;
  metadata: unknown;
  createdAt: Date;
  booking: { id: string; startAt: Date; serviceName: string } | null;
};

function NotificationCard({ entry, accent }: { entry: EntryWithBooking; accent: string }) {
  const v = renderFor(entry);
  const iconColor = v.toneColor ?? accent;
  return (
    <li className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: hexToTint(iconColor), color: iconColor }}
        aria-hidden
      >
        {v.icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-900">{v.title}</div>
        {v.detail && <div className="mt-0.5 text-xs text-slate-600">{v.detail}</div>}
        <div className="mt-1 text-[11px] text-slate-400">{relativeTime(entry.createdAt)}</div>
      </div>
    </li>
  );
}

function EmptyState({ accent }: { accent: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
      <div
        className="mx-auto flex h-12 w-12 items-center justify-center rounded-full"
        style={{ backgroundColor: hexToTint(accent), color: accent }}
        aria-hidden
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M13.7 21a2 2 0 0 1-3.4 0" strokeLinecap="round" />
        </svg>
      </div>
      <h2 className="mt-4 text-base font-semibold tracking-tight text-slate-900">
        Nothing here yet
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        We&rsquo;ll surface booking confirmations, reminders, and other updates as they happen.
      </p>
    </div>
  );
}

// ─── Rendering helpers ────────────────────────────────────────────────

function renderFor(e: EntryWithBooking): {
  title: string;
  detail?: string;
  icon: React.ReactNode;
  toneColor?: string;
} {
  const svcName = e.booking?.serviceName ?? "your booking";
  const md = (e.metadata ?? {}) as Record<string, unknown>;

  switch (e.action) {
    case "booking.create":
      return {
        title: `${svcName} confirmed`,
        detail: e.booking ? `Scheduled for ${formatBookingTime(e.booking.startAt)}.` : undefined,
        toneColor: "#16a34a",
        icon: <CheckIcon />,
      };
    case "booking.cancel":
      return {
        title: `${svcName} cancelled`,
        detail: e.booking ? `Was scheduled for ${formatBookingTime(e.booking.startAt)}.` : undefined,
        toneColor: "#dc2626",
        icon: <XIcon />,
      };
    case "booking.reschedule": {
      const newStart = typeof md.newStartAt === "string" ? md.newStartAt : null;
      return {
        title: `${svcName} rescheduled`,
        detail: newStart ? `New time: ${formatBookingTime(new Date(newStart))}.` : undefined,
        toneColor: "#0891b2",
        icon: <RefreshIcon />,
      };
    }
    case "email.sent": {
      const kind = typeof md.kind === "string" ? md.kind : "email";
      return {
        title: prettyEmailKind(kind),
        detail: e.booking ? `Sent for ${svcName} on ${formatBookingTime(e.booking.startAt)}.` : undefined,
        icon: <MailIcon />,
      };
    }
    case "email.failed":
      return {
        title: "Couldn't deliver an email",
        detail: e.booking ? `About ${svcName}.` : "We'll retry shortly.",
        toneColor: "#b45309",
        icon: <AlertIcon />,
      };
    default:
      return { title: e.action, icon: <BellIcon /> };
  }
}

function prettyEmailKind(k: string): string {
  switch (k) {
    case "confirmation": return "Booking confirmation sent";
    case "cancellation": return "Cancellation notice sent";
    case "reschedule":   return "Reschedule confirmation sent";
    case "reminder":     return "Appointment reminder sent";
    default:             return "Email sent";
  }
}

function formatBookingTime(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function relativeTime(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toISOString().slice(0, 10);
}

function groupByDay(
  entries: EntryWithBooking[]
): { label: string; entries: EntryWithBooking[] }[] {
  if (entries.length === 0) return [];
  const buckets = new Map<string, EntryWithBooking[]>();
  for (const e of entries) {
    const day = e.createdAt.toISOString().slice(0, 10);
    const arr = buckets.get(day) ?? [];
    arr.push(e);
    buckets.set(day, arr);
  }
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, list]) => ({
      label: day === today ? "Today" : day === yesterday ? "Yesterday" : day,
      entries: list,
    }));
}

function hexToTint(hex: string): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return "#eef2ff";
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const blend = (c: number) => Math.round(c * 0.15 + 255 * 0.85);
  return `rgb(${blend(r)}, ${blend(g)}, ${blend(b)})`;
}

// ─── Tiny icons ──────────────────────────────────────────────────────

function iconBase(d: string) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-4 w-4" aria-hidden>
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
const CheckIcon = () => iconBase("M5 13l4 4L19 7");
const XIcon = () => iconBase("M6 6l12 12M6 18L18 6");
const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-4 w-4" aria-hidden>
    <path d="M3 12a9 9 0 0 1 15-6l3 3M21 12a9 9 0 0 1-15 6l-3-3M21 3v6h-6M3 21v-6h6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const MailIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-4 w-4" aria-hidden>
    <path d="M4 4h16v16H4zM4 4l8 8 8-8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const AlertIcon = () => iconBase("M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z");
const BellIcon = () => iconBase("M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M13.7 21a2 2 0 0 1-3.4 0");

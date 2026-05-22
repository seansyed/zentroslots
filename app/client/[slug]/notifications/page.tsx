import { and, desc, eq, inArray } from "drizzle-orm";
import {
  Bell,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Mail,
  AlertTriangle,
} from "lucide-react";

import { db } from "@/db/client";
import { auditLogs, bookings, services } from "@/db/schema";
import ClientPortalShell from "@/components/client/ClientPortalShell";
import { TimeText } from "@/components/client/TimeText";
import { requireClientPortalContext } from "../_lib/guard";

export const dynamic = "force-dynamic";

// Notifications are derived from existing audit_logs scoped to this
// customer's bookings. No per-client read-state table yet — that's
// scoped out per the brief. The page surfaces booking lifecycle events
// and operational email events that the customer cares about.

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

  // Bookings owned by this customer (email-equality is the canonical
  // ownership rule per the existing portal).
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
              <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
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
  const IconComponent = v.Icon;
  return (
    <li className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start gap-3">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: hexToTint(iconColor), color: iconColor }}
          aria-hidden
        >
          <IconComponent className="h-4 w-4" strokeWidth={2.25} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium tracking-tight text-slate-900">{v.title}</div>
          {v.detail && <div className="mt-0.5 text-[12px] text-slate-600">{v.detail}</div>}
          <div className="mt-1 text-[11px] text-slate-400">
            <TimeText iso={entry.createdAt.toISOString()} format="h:mm a" />
            <span aria-hidden> · </span>
            {relativeTime(entry.createdAt)}
          </div>
        </div>
      </div>
    </li>
  );
}

function EmptyState({ accent }: { accent: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-dashed border-slate-300 bg-gradient-to-br from-slate-50/70 to-white p-10 text-center shadow-sm">
      <div
        className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl shadow-sm ring-1 ring-slate-200"
        style={{ backgroundColor: hexToTint(accent), color: accent }}
        aria-hidden
      >
        <Bell className="h-5 w-5" strokeWidth={1.75} />
      </div>
      <h2 className="mt-4 text-[14.5px] font-semibold tracking-tight text-slate-900">
        Nothing here yet
      </h2>
      <p className="mt-1 text-[12.5px] leading-relaxed text-slate-600">
        We&rsquo;ll surface booking confirmations, reminders, and other updates as they happen.
      </p>
    </div>
  );
}

// ─── Rendering helpers ────────────────────────────────────────────────

type RenderedEntry = {
  title: string;
  detail?: React.ReactNode;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  toneColor?: string;
};

function renderFor(e: EntryWithBooking): RenderedEntry {
  const svcName = e.booking?.serviceName ?? "your booking";
  const md = (e.metadata ?? {}) as Record<string, unknown>;

  switch (e.action) {
    case "booking.create":
      return {
        title: `${svcName} confirmed`,
        detail: e.booking ? (
          <>
            Scheduled for <BookingTimeText iso={e.booking.startAt} />.
          </>
        ) : undefined,
        toneColor: "#16a34a",
        Icon: CheckCircle2,
      };
    case "booking.cancel":
      return {
        title: `${svcName} cancelled`,
        detail: e.booking ? (
          <>
            Was scheduled for <BookingTimeText iso={e.booking.startAt} />.
          </>
        ) : undefined,
        toneColor: "#dc2626",
        Icon: XCircle,
      };
    case "booking.reschedule": {
      const newStart = typeof md.newStartAt === "string" ? md.newStartAt : null;
      return {
        title: `${svcName} rescheduled`,
        detail: newStart ? (
          <>
            New time: <BookingTimeText iso={new Date(newStart)} />.
          </>
        ) : undefined,
        toneColor: "#0891b2",
        Icon: RotateCcw,
      };
    }
    case "email.sent": {
      const kind = typeof md.kind === "string" ? md.kind : "email";
      return {
        title: prettyEmailKind(kind),
        detail: e.booking ? (
          <>
            Sent for {svcName} on <BookingTimeText iso={e.booking.startAt} />.
          </>
        ) : undefined,
        Icon: Mail,
      };
    }
    case "email.failed":
      return {
        title: "Couldn't deliver an email",
        detail: e.booking ? <>About {svcName}.</> : "We'll retry shortly.",
        toneColor: "#b45309",
        Icon: AlertTriangle,
      };
    default:
      return { title: e.action, Icon: Bell };
  }
}

function BookingTimeText({ iso }: { iso: string | Date }) {
  const isoStr = typeof iso === "string" ? iso : iso.toISOString();
  return <TimeText iso={isoStr} format="EEE, MMM d · h:mm a" />;
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

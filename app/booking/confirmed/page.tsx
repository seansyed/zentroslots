/**
 * Wave H Phase 3 follow-up — payment-success landing page.
 *
 *   /booking/confirmed?booking=<uuid>
 *
 * Where Stripe / PayPal hosted checkout sends the customer after a
 * successful payment. The webhook is the sole source of truth for
 * finalization, so this page MUST NOT confirm the booking itself —
 * it only renders the current state and polls until the webhook flips
 * status from `pending_payment` → `confirmed`.
 *
 * Race window: typical webhook delivery is sub-second, but provider
 * delays can stretch it to ~30s in rare cases. We poll up to 30s,
 * then degrade gracefully ("you'll receive a confirmation email
 * shortly") so the customer never sees a broken UI.
 *
 * Privacy: same UUID-as-access-token model as the cancelled page.
 * Limited fields surfaced.
 */

import Link from "next/link";
import { eq } from "drizzle-orm";
import { CheckCircle2, Home } from "lucide-react";

import { db } from "@/db/client";
import { bookings, services, tenants, users } from "@/db/schema";
import BookingConfirmedStatus from "@/components/booking/BookingConfirmedStatus";
import AddToCalendarButtons from "@/components/booking/AddToCalendarButtons";
import BookingCompletedTracker from "@/components/analytics/BookingCompletedTracker";
import { signBookingToken } from "@/lib/tokens";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BookingSummary {
  id: string;
  status: string;
  startAt: Date;
  endAt: Date;
  serviceName: string;
  staffName: string;
  meetLink: string | null;
  /** Tenant id — needed to mint a kind=ics signed token for the
   *  AddToCalendarButtons component (Phase ICAL-1). Not surfaced
   *  in the rendered UI — server-side use only. */
  tenantId: string;
  /** Phase GA4 — feeds the BookingCompletedTracker so it can split
   *  conversion volume into "free" vs "paid" buckets WITHOUT sending
   *  the exact price to Google. Categorical only. */
  servicePrice: number;
  /** Phase GA4 — public tenant slug (already in the booking URL —
   *  not PII). Categorical aggregation key for GA4. */
  tenantSlug: string | null;
}

async function lookupBooking(bookingId: string): Promise<BookingSummary | null> {
  if (!UUID_RE.test(bookingId)) return null;
  const row = await db
    .select({
      id: bookings.id,
      status: bookings.status,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      serviceName: services.name,
      staffName: users.name,
      meetLink: bookings.meetLink,
      tenantId: bookings.tenantId,
      servicePrice: services.price,
      tenantSlug: tenants.slug,
    })
    .from(bookings)
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .leftJoin(users, eq(users.id, bookings.staffUserId))
    .leftJoin(tenants, eq(tenants.id, bookings.tenantId))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  const r = row[0];
  if (!r || !r.serviceName || !r.staffName) return null;
  return {
    ...r,
    // Defensive — if the join misses (shouldn't, but cheap to guard),
    // default the GA-only fields rather than 404-ing the page.
    servicePrice: r.servicePrice ?? 0,
    tenantSlug: r.tenantSlug ?? null,
  } as BookingSummary;
}

function formatDate(start: Date): { day: string; time: string } {
  const dayFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return { day: dayFmt.format(start), time: timeFmt.format(start) };
}

// Phase ICAL-1 — inline gcalUrl/outlookUrl helpers were extracted
// into lib/calendar/ics/calendarLinks.ts so the email engine, the
// public download endpoint, and this confirmation page all build
// IDENTICAL Add-to-Calendar links. See AddToCalendarButtons.tsx for
// the four-provider button row that replaces the old two buttons.

export default async function PaymentConfirmedPage({
  searchParams,
}: {
  searchParams: Promise<{ booking?: string }>;
}) {
  const { booking: bookingId } = await searchParams;
  const summary = bookingId ? await lookupBooking(bookingId) : null;

  if (!summary) {
    return (
      <div className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center px-6 py-12 text-center">
        <div className="text-6xl font-semibold text-slate-300">404</div>
        <h1 className="mt-3 text-xl font-semibold">Booking not found</h1>
        <p className="mt-2 text-sm text-slate-600">
          The link may be expired or incorrect.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          <Home className="h-3.5 w-3.5" />
          Back to home
        </Link>
      </div>
    );
  }

  const { day, time } = formatDate(summary.startAt);
  const calTitle = `Meeting with ${summary.staffName} — ${summary.serviceName}`;
  const calDesc = summary.meetLink ? `Join: ${summary.meetLink}` : "";

  // Phase ICAL-1 — sign a kind=ics token so the AddToCalendarButtons
  // component can render an Apple Calendar / .ics download link that
  // streams the latest booking state through the public download
  // endpoint. Token is bound to this specific booking + tenant.
  const icsToken = await signBookingToken({
    bookingId: summary.id,
    tenantId: summary.tenantId,
    kind: "ics",
  });

  return (
    <div className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
        <CheckCircle2 className="h-7 w-7" />
      </div>
      <h1 className="text-2xl font-semibold text-slate-900">You&apos;re booked!</h1>

      {/* Live status — flips from "Finalizing..." to "Confirmed" via
          the public status poll. The booking row is updated by the
          payment webhook (sole source of truth), not by this page. */}
      <BookingConfirmedStatus bookingId={summary.id} initialStatus={summary.status} />

      <div className="mt-6 w-full rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Your booking
        </div>
        <div className="mt-2 text-base font-medium text-slate-900">
          {summary.serviceName}
        </div>
        <div className="mt-1 text-sm text-slate-700">{day}</div>
        <div className="text-sm text-slate-700">{time}</div>
        <div className="mt-2 text-sm text-slate-600">with {summary.staffName}</div>
        {summary.meetLink && (
          <a
            href={summary.meetLink}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:text-blue-900 break-all"
          >
            Join meeting link →
          </a>
        )}
      </div>

      {/* Phase ICAL-1 — universal Add-to-Calendar row. Replaces the
          old two inline buttons with Apple / Google / Outlook /
          Yahoo + an .ics download. Apple support via signed-token
          download (Apple has no documented web-add deep link). */}
      <AddToCalendarButtons
        event={{
          title: calTitle,
          startAt: summary.startAt,
          endAt: summary.endAt,
          description: calDesc,
          location: summary.meetLink ?? undefined,
        }}
        icsToken={icsToken}
      />

      <p className="mt-6 text-xs text-slate-500">
        A confirmation email is on its way.
      </p>

      {/* Phase GA4 — fire `booking_completed` once per browser session
          per booking ID. Renders nothing visually. We pass categorical
          fields only: value_bucket ("free"|"paid" — never the price)
          and service_name + tenant_slug. No customer identifiers. */}
      <BookingCompletedTracker
        bookingId={summary.id}
        valueBucket={summary.servicePrice > 0 ? "paid" : "free"}
        serviceName={summary.serviceName}
        tenantSlug={summary.tenantSlug}
      />
    </div>
  );
}

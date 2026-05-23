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
import { bookings, services, users } from "@/db/schema";
import BookingConfirmedStatus from "@/components/booking/BookingConfirmedStatus";

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
    })
    .from(bookings)
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .leftJoin(users, eq(users.id, bookings.staffUserId))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  const r = row[0];
  if (!r || !r.serviceName || !r.staffName) return null;
  return r as BookingSummary;
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

/** Build a Google Calendar quick-add URL. Browsers handle the rest —
 *  the customer's signed-in Google account opens with the event
 *  pre-filled, they click Save. */
function gcalUrl(args: { title: string; start: Date; end: Date; description: string }): string {
  const fmt = (d: Date) =>
    d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: args.title,
    dates: `${fmt(args.start)}/${fmt(args.end)}`,
    details: args.description,
  });
  return `https://www.google.com/calendar/render?${params.toString()}`;
}

function outlookUrl(args: { title: string; start: Date; end: Date; description: string }): string {
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    startdt: args.start.toISOString(),
    enddt: args.end.toISOString(),
    subject: args.title,
    body: args.description,
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

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

      <div className="mt-4 flex flex-col sm:flex-row gap-2 w-full">
        <a
          href={gcalUrl({
            title: calTitle,
            start: summary.startAt,
            end: summary.endAt,
            description: calDesc,
          })}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
        >
          Add to Google Calendar
        </a>
        <a
          href={outlookUrl({
            title: calTitle,
            start: summary.startAt,
            end: summary.endAt,
            description: calDesc,
          })}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
        >
          Add to Outlook
        </a>
      </div>

      <p className="mt-6 text-xs text-slate-500">
        A confirmation email is on its way.
      </p>
    </div>
  );
}

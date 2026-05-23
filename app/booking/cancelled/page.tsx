/**
 * Wave H Phase 3 follow-up — payment-cancelled landing page.
 *
 *   /booking/cancelled?booking=<uuid>
 *
 * Where Stripe / PayPal hosted checkout sends the customer when they
 * abandon the payment step (clicked "back" or "cancel" on the
 * provider's page). The booking row stays in `pending_payment` until
 * the expire-payment-holds cron releases the slot — we do NOT mutate
 * the booking here, since the customer might still reopen Stripe and
 * pay successfully within the hold window.
 *
 * Privacy: the booking UUID in the URL is the access token (122 bits
 * of entropy). We render limited fields — service name, scheduled
 * time, host name — never email/notes/internal IDs.
 */

import Link from "next/link";
import { eq } from "drizzle-orm";
import { XCircle, ArrowRight, ArrowLeft } from "lucide-react";

import { db } from "@/db/client";
import { bookings, services, tenants, users } from "@/db/schema";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BookingSummary {
  id: string;
  startAt: Date;
  endAt: Date;
  serviceId: string;
  serviceName: string;
  serviceSlug: string;
  staffName: string;
  /** Tenant slug — used for the "View other times" CTA which points
   *  the customer back to the host's profile (/u/<slug>), not to the
   *  ZentroMeet marketing root. */
  tenantSlug: string;
  /** Tenant display name — used in the CTA label so the customer sees
   *  "Back to Acme Co." instead of a generic "back" link. */
  tenantName: string;
}

async function lookupBooking(bookingId: string): Promise<BookingSummary | null> {
  if (!UUID_RE.test(bookingId)) return null;
  const row = await db
    .select({
      id: bookings.id,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      serviceId: bookings.serviceId,
      serviceName: services.name,
      serviceSlug: services.slug,
      staffName: users.name,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
    })
    .from(bookings)
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .leftJoin(users, eq(users.id, bookings.staffUserId))
    .leftJoin(tenants, eq(tenants.id, bookings.tenantId))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  const r = row[0];
  if (
    !r ||
    !r.serviceName ||
    !r.serviceSlug ||
    !r.staffName ||
    !r.tenantSlug ||
    !r.tenantName
  ) {
    return null;
  }
  return r as BookingSummary;
}

function formatSlot(start: Date, end: Date): string {
  // Render in the SERVER's local zone — close enough for the "you
  // cancelled" copy. The original booking page already showed the
  // customer their local time. Browsers don't get this page for very
  // long anyway (it's a one-shot landing).
  const dayFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${dayFmt.format(start)}, ${timeFmt.format(start)}–${timeFmt.format(end)}`;
}

export default async function PaymentCancelledPage({
  searchParams,
}: {
  searchParams: Promise<{ booking?: string }>;
}) {
  const { booking: bookingId } = await searchParams;
  const summary = bookingId ? await lookupBooking(bookingId) : null;

  return (
    <div className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-amber-600">
        <XCircle className="h-7 w-7" />
      </div>
      <h1 className="text-2xl font-semibold text-slate-900">Booking not completed</h1>
      <p className="mt-2 text-sm text-slate-600 leading-relaxed">
        You cancelled at the payment step, so we didn&apos;t charge anything.
        Your time slot is held for a short while — feel free to come back and
        finish whenever you&apos;re ready.
      </p>

      {summary && (
        <div className="mt-6 w-full rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            What you were booking
          </div>
          <div className="mt-2 text-base font-medium text-slate-900">
            {summary.serviceName}
          </div>
          <div className="mt-1 text-sm text-slate-700">
            {formatSlot(summary.startAt, summary.endAt)}
          </div>
          <div className="mt-0.5 text-sm text-slate-600">with {summary.staffName}</div>
        </div>
      )}

      <div className="mt-6 flex flex-col sm:flex-row gap-2 w-full">
        {summary && (
          <>
            {/* Try again → the same service's canonical public booking
                URL (/u/<tenantSlug>/<serviceSlug>). NOT /book/<id> —
                that route exists only as /book/<serviceId>/<staffId>
                and would 404 here. The /u/ pattern is the one customers
                originally arrived through. */}
            <Link
              href={`/u/${summary.tenantSlug}/${summary.serviceSlug}`}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 transition-colors"
            >
              Try again
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
            {/* Secondary CTA points back to the HOST'S profile, not to
                ZentroMeet's marketing home. The customer never thinks of
                themselves as "leaving ZentroMeet" — they're booking with
                a specific person/business. */}
            <Link
              href={`/u/${summary.tenantSlug}`}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              View other times
            </Link>
          </>
        )}
        {!summary && (
          // Fallback when the booking row can't be resolved (deleted
          // tenant, malformed link, etc.) — at that point we have no
          // host context to send them to, so the marketing home is the
          // only meaningful destination.
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            Go to ZentroMeet
          </Link>
        )}
      </div>

      <p className="mt-6 text-xs text-slate-500">
        Trouble paying? Try a different card, or contact the host directly.
      </p>
    </div>
  );
}

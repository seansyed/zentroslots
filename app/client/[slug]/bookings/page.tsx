import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { billingTransactions, bookings, services, users } from "@/db/schema";
import ClientPortalShell from "@/components/client/ClientPortalShell";
import { TimeText } from "@/components/client/TimeText";
import FeedbackChip from "@/components/client/FeedbackChip";
import { loadTenantFeatures } from "@/lib/features";
import { signBookingToken } from "@/lib/tokens";
import { requireClientPortalContext } from "../_lib/guard";

export const dynamic = "force-dynamic";

export default async function ClientBookingsPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const { tenant, customer, hasUnread } = await requireClientPortalContext(slug);

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
      // F31 — used to decide whether to surface the FeedbackChip on
      // completed past bookings.
      feedbackSubmittedAt: bookings.feedbackSubmittedAt,
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

  // F8 — Receipts & payments. Query billing_transactions matched either
  // by direct customer_id link (newer transactions set this) OR by
  // booking_id within this customer's bookings (older / booking-only
  // transactions). Both paths are tenant-scoped. Capped at 20 rows.
  const txRows = await db.execute<{
    id: string;
    amount_cents: string | number;
    currency: string;
    transaction_type: string;
    status: string;
    paid_at: Date | null;
    refunded_at: Date | null;
    created_at: Date;
    stripe_payment_intent_id: string | null;
    stripe_invoice_id: string | null;
    metadata: Record<string, unknown> | null;
    booking_id: string | null;
  }>(sql`
    SELECT id,
           amount_cents,
           currency,
           transaction_type,
           status,
           paid_at,
           refunded_at,
           created_at,
           stripe_payment_intent_id,
           stripe_invoice_id,
           metadata,
           booking_id
      FROM ${billingTransactions}
     WHERE ${billingTransactions.tenantId} = ${tenant.id}
       AND (
         ${billingTransactions.customerId} = ${customer.id}
         OR ${billingTransactions.bookingId} IN (
           SELECT id FROM ${bookings}
            WHERE ${bookings.tenantId} = ${tenant.id}
              AND lower(${bookings.clientEmail}) = ${customer.email.toLowerCase()}
         )
       )
     ORDER BY COALESCE(paid_at, created_at) DESC
     LIMIT 20
  `);
  const transactions = Array.from(txRows).map((t) => ({
    id: String(t.id),
    amountCents: Number(t.amount_cents),
    currency: String(t.currency || "usd"),
    transactionType: String(t.transaction_type || "payment"),
    status: String(t.status || ""),
    paidAt: t.paid_at,
    refundedAt: t.refunded_at,
    createdAt: t.created_at,
    bookingId: t.booking_id as string | null,
    // Stripe persists a receipt_url on the metadata bag when the
    // webhook captured it. Optional — surfaces a "View receipt" link
    // when present, otherwise the row is read-only.
    receiptUrl: extractReceiptUrl(t.metadata),
  }));

  // F31 — find the most recent completed booking without feedback yet.
  // The bookings list is already sorted DESC, so the first match is the
  // most recent. We surface a single FeedbackChip above Past — not one
  // per row, to keep visual weight low.
  const pendingFeedback = past.find(
    (b) => b.status === "completed" && !b.feedbackSubmittedAt,
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
      hasUnread={hasUnread}
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

      {/* F8 — Receipts & payments. Only renders when the customer has
          at least one transaction. Zero-state hides the section so
          customers of free-only workspaces don't see a stub. */}
      {transactions.length > 0 && (
        <section className="mt-8 space-y-4">
          <SectionHeader label="Receipts & payments" count={transactions.length} />
          <ul className="space-y-2">
            {transactions.map((t) => (
              <ReceiptRow
                key={t.id}
                tx={{
                  ...t,
                  paidAt: t.paidAt ? t.paidAt.toISOString() : null,
                  refundedAt: t.refundedAt ? t.refundedAt.toISOString() : null,
                  createdAt: t.createdAt.toISOString(),
                }}
                accent={tenant.primaryColor}
              />
            ))}
          </ul>
        </section>
      )}

      {/* F31 — Pending feedback prompt. One chip for the most recent
          completed booking without feedback yet. Sits above Past so
          customers see it on first arrival on the page. */}
      {pendingFeedback && (
        <div className="mt-8">
          <FeedbackChip
            tenantSlug={tenant.slug}
            bookingId={pendingFeedback.id}
            serviceName={pendingFeedback.serviceName}
            staffName={pendingFeedback.staffName}
            accent={tenant.primaryColor}
          />
        </div>
      )}

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
              {/* F11 — ICS download. The route handler verifies the
                  client session + booking ownership, then returns a
                  text/calendar attachment so the browser saves it. */}
              <a
                href={`/api/client/${encodeURIComponent(tenantSlug)}/bookings/${encodeURIComponent(booking.id)}/ics`}
                className="inline-flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-sm"
                aria-label="Download calendar file (.ics)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden>
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <path d="M16 2v4M8 2v4M3 10h18M12 14v4M10 16h4" strokeLinecap="round" />
                </svg>
                Add to calendar
              </a>
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

/**
 * Looks for a Stripe-style receipt URL inside the metadata bag.
 * The Stripe webhook stores `charges.data[0].receipt_url` and/or
 * `hosted_invoice_url` in metadata when available. Both are
 * customer-facing URLs Stripe hosts; safe to link externally.
 * Returns null when neither is present (no link rendered).
 */
function extractReceiptUrl(metadata: Record<string, unknown> | null): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  const candidates = [m.receipt_url, m.receiptUrl, m.hosted_invoice_url, m.hostedInvoiceUrl];
  for (const c of candidates) {
    if (typeof c === "string" && (c.startsWith("https://") || c.startsWith("http://"))) {
      return c;
    }
  }
  return null;
}

function formatMoney(cents: number, currency: string): string {
  // Use Intl.NumberFormat for locale + currency-symbol correctness.
  // Stripe stores zero-decimal currencies (JPY, KRW) as integer units;
  // since we don't know in advance, treat amount as cents always.
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function prettyTxType(t: string): string {
  switch (t) {
    case "booking_payment":     return "Booking payment";
    case "subscription_payment": return "Subscription";
    case "subscription_renewal": return "Subscription renewal";
    case "refund":               return "Refund";
    case "deposit":              return "Deposit";
    default:                     return capitalize(t.replace(/_/g, " "));
  }
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

function ReceiptRow({
  tx,
  accent,
}: {
  tx: {
    id: string;
    amountCents: number;
    currency: string;
    transactionType: string;
    status: string;
    paidAt: string | null;
    refundedAt: string | null;
    createdAt: string;
    receiptUrl: string | null;
  };
  accent: string;
}) {
  const tone = receiptTone(tx.status, tx.transactionType);
  const isRefund = tx.transactionType === "refund" || tx.status === "refunded";
  // Use refundedAt for refunds, paidAt for charges, created_at as a
  // last-resort fallback so even pending rows render a date.
  const whenIso = isRefund && tx.refundedAt
    ? tx.refundedAt
    : tx.paidAt ?? tx.createdAt;

  return (
    <li className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-center gap-3">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: tone.iconBg, color: tone.iconColor }}
          aria-hidden
        >
          {isRefund ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path d="M3 12a9 9 0 1 0 3-6.7M3 3v6h6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <rect x="2" y="6" width="20" height="12" rx="2" />
              <path d="M2 10h20M7 14h4" strokeLinecap="round" />
            </svg>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-semibold tracking-tight text-slate-900">
                {prettyTxType(tx.transactionType)}
              </div>
              <div className="text-[11.5px] text-slate-500">
                <TimeText iso={whenIso} format="MMM d, yyyy · h:mm a" />
              </div>
            </div>
            <div className="text-right">
              <div className="text-[13.5px] font-semibold tabular-nums text-slate-900">
                {isRefund ? "−" : ""}{formatMoney(tx.amountCents, tx.currency)}
              </div>
              <ReceiptStatusBadge status={tx.status} isRefund={isRefund} />
            </div>
          </div>
          {tx.receiptUrl && (
            <div className="mt-2">
              <a
                href={tx.receiptUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11.5px] font-medium transition-colors"
                style={{ color: accent }}
              >
                View receipt
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden>
                  <path d="M7 17l10-10M7 7h10v10" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function receiptTone(status: string, type: string): { iconBg: string; iconColor: string } {
  if (type === "refund" || status === "refunded") {
    return { iconBg: "#fef2f2", iconColor: "#b91c1c" };
  }
  if (status === "succeeded" || status === "paid") {
    return { iconBg: "#ecfdf5", iconColor: "#047857" };
  }
  if (status === "pending") {
    return { iconBg: "#fffbeb", iconColor: "#b45309" };
  }
  if (status === "failed") {
    return { iconBg: "#fef2f2", iconColor: "#b91c1c" };
  }
  return { iconBg: "#f1f5f9", iconColor: "#475569" };
}

function ReceiptStatusBadge({ status, isRefund }: { status: string; isRefund: boolean }) {
  const labelMap: Record<string, { label: string; bg: string; text: string; dot: string }> = {
    succeeded: { label: "Paid",      bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500" },
    paid:      { label: "Paid",      bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500" },
    refunded:  { label: "Refunded",  bg: "bg-rose-50",    text: "text-rose-700",    dot: "bg-rose-500" },
    failed:    { label: "Failed",    bg: "bg-rose-50",    text: "text-rose-700",    dot: "bg-rose-500" },
    pending:   { label: "Pending",   bg: "bg-amber-50",   text: "text-amber-700",   dot: "bg-amber-500" },
  };
  const fallback = { label: capitalize(status || "unknown"), bg: "bg-slate-100", text: "text-slate-700", dot: "bg-slate-400" };
  const s = isRefund && !labelMap[status] ? labelMap.refunded : (labelMap[status] ?? fallback);
  return (
    <span className={`mt-0.5 inline-flex items-center gap-1.5 rounded-full ${s.bg} px-2 py-0.5 text-[10px] font-medium ${s.text}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
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

"use client";

/**
 * Wave H Phase 3 follow-up — status indicator for /booking/confirmed.
 *
 * Polls /api/public/bookings/<id>/status every 2 seconds until the
 * booking transitions out of `pending_payment` (the webhook is what
 * actually flips it). After ~30s with no transition we degrade
 * gracefully to a "we'll email you" line.
 *
 * This component NEVER mutates a booking — the public status endpoint
 * is read-only by design. Webhook is sole source of truth.
 */

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, AlertCircle } from "lucide-react";

interface StatusResponse {
  id: string;
  status: string;
  paymentPending: boolean;
}

export default function BookingConfirmedStatus({
  bookingId,
  initialStatus,
}: {
  bookingId: string;
  initialStatus: string;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [polled, setPolled] = useState(0);

  useEffect(() => {
    // Already finalized on the server-rendered fetch? Nothing to poll.
    if (status !== "pending_payment") return;

    // Give up after 15 polls × 2s = 30s — typical webhook delivery is
    // sub-second, so 30s is comfortable margin without spinning forever.
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/public/bookings/${bookingId}/status`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as StatusResponse;
        if (cancelled) return;
        if (data.status !== "pending_payment") {
          setStatus(data.status);
        }
      } catch {
        // Swallow — next tick will retry. Network blip shouldn't
        // surface as an error to the customer.
      }
    };

    const interval = setInterval(() => {
      setPolled((n) => {
        const next = n + 1;
        if (next >= 15) {
          clearInterval(interval);
        } else {
          void tick();
        }
        return next;
      });
    }, 2_000);

    // Fire one immediately so we don't make the customer wait the full
    // first 2s. The server-rendered page may already have caught the
    // flip, but the webhook could land in the gap between render +
    // first poll.
    void tick();

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [bookingId, status]);

  if (status === "confirmed" || status === "completed") {
    return (
      <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 border border-emerald-200">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Booking confirmed
      </div>
    );
  }

  if (status === "cancelled" || status === "payment_failed") {
    // Defensive — shouldn't normally see this on the success-redirect
    // page, but if Stripe pays then refunds quickly, or the customer
    // navigated here manually, give them clean copy.
    return (
      <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 border border-amber-200">
        <AlertCircle className="h-3.5 w-3.5" />
        Booking could not be confirmed — please contact the host.
      </div>
    );
  }

  // Still pending_payment. Show different copy at the boundary so the
  // customer doesn't think we're stuck.
  if (polled >= 15) {
    return (
      <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-800 border border-blue-200">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Payment received — confirmation email on its way
      </div>
    );
  }

  return (
    <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 border border-slate-200">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      Finalizing your booking…
    </div>
  );
}

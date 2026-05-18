"use client";

import * as React from "react";

import { Button, Card, Skeleton, toast } from "@/components/ui/primitives";

type ClaimData = {
  status: string;
  expiresAt: string;
  expired: boolean;
  slot: { startAt: string | null; endAt: string | null };
  service: { id: string; name: string } | null;
  staff: { name: string; timezone: string } | null;
  tenant: { name: string; slug: string; primaryColor: string } | null;
  customer: { name: string; email: string };
};

export default function WaitlistClaimClient({ token }: { token: string }) {
  const [data, setData] = React.useState<ClaimData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [claiming, setClaiming] = React.useState(false);
  const [doneBookingId, setDoneBookingId] = React.useState<string | null>(null);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  // Initial fetch.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/waitlist/claim/${encodeURIComponent(token)}`);
        const d = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setErrorMsg(d?.error ?? "This claim link is no longer valid.");
        } else {
          setData(d);
        }
      } catch (e) {
        if (!cancelled) setErrorMsg(e instanceof Error ? e.message : "Failed to load reservation");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Tick the countdown every second.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function claim() {
    setClaiming(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/public/waitlist/claim/${encodeURIComponent(token)}`, {
        method: "POST",
      });
      const d = await res.json();
      if (!res.ok) {
        setErrorMsg(d?.error ?? "Could not claim this slot.");
        return;
      }
      setDoneBookingId(d.bookingId);
      toast("Slot claimed!", "success");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Could not claim this slot.");
    } finally {
      setClaiming(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  if (errorMsg && !data) {
    return (
      <Card className="p-6">
        <h1 className="text-lg font-semibold text-ink">Reservation unavailable</h1>
        <p className="mt-2 text-sm text-ink-muted">{errorMsg}</p>
      </Card>
    );
  }

  if (!data) return null;

  const accent = data.tenant?.primaryColor ?? "#2563eb";

  if (doneBookingId) {
    return (
      <Card className="p-6 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 ring-4 ring-green-50" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-6 w-6 text-green-600">
            <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1 className="mt-3 text-lg font-semibold text-ink">You&rsquo;re booked!</h1>
        <p className="mt-1 text-sm text-ink-muted">
          A confirmation is on its way to {data.customer.email}.
        </p>
      </Card>
    );
  }

  const expiresMs = new Date(data.expiresAt).getTime();
  const remainingMs = expiresMs - now;
  const isLive = !data.expired && data.status === "sent" && remainingMs > 0;

  if (!isLive) {
    return (
      <Card className="p-6">
        <h1 className="text-lg font-semibold text-ink">Reservation expired</h1>
        <p className="mt-2 text-sm text-ink-muted">
          This slot was offered to you but the reservation window has closed.
          {data.service && data.tenant && (
            <> You can rejoin the waitlist for <b>{data.service.name}</b> at <b>{data.tenant.name}</b>.</>
          )}
        </p>
        {data.tenant && (
          <a
            href={`/u/${data.tenant.slug}`}
            className="mt-4 inline-flex rounded-md px-4 py-2 text-sm font-medium text-white shadow-sm"
            style={{ backgroundColor: accent }}
          >
            Back to {data.tenant.name}
          </a>
        )}
      </Card>
    );
  }

  const min = Math.floor(remainingMs / 60_000);
  const sec = Math.floor((remainingMs % 60_000) / 1000);

  const start = data.slot.startAt ? new Date(data.slot.startAt) : null;
  const tz = data.staff?.timezone ?? "UTC";

  return (
    <div className="space-y-4">
      {data.tenant && (
        <div className="text-xs font-medium uppercase tracking-wider text-ink-subtle">
          {data.tenant.name}
        </div>
      )}
      <h1 className="text-2xl font-semibold text-ink">A spot just opened</h1>
      <p className="text-sm text-ink-muted">
        You&rsquo;re first in line for <b>{data.service?.name ?? "this service"}</b>. Claim it before the window closes.
      </p>

      <Card className="p-5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">When</div>
        {start && (
          <div className="mt-1 text-sm font-medium text-ink">
            {start.toLocaleString("en-US", {
              timeZone: tz,
              weekday: "long",
              month: "long",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              timeZoneName: "short",
            })}
          </div>
        )}
        {data.staff && (
          <div className="mt-2 text-xs text-ink-muted">with {data.staff.name}</div>
        )}
      </Card>

      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-center text-sm text-amber-900">
        Reservation expires in <b className="tabular-nums">{min}:{String(sec).padStart(2, "0")}</b>
      </div>

      <Button onClick={claim} disabled={claiming} className="w-full">
        {claiming ? "Claiming…" : "Claim this slot"}
      </Button>

      {errorMsg && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          {errorMsg}
        </div>
      )}
    </div>
  );
}

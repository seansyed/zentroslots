"use client";

import * as React from "react";
import { formatInTimeZone } from "date-fns-tz";

import { Drawer, Button, Badge, toast } from "@/components/ui/primitives";
import { STATUS_LABEL, STATUS_BADGE, type Status } from "@/lib/status-colors";

export type DrawerBooking = {
  id: string;
  startAt: string;
  endAt: string;
  status: Status;
  clientName: string;
  clientEmail: string;
  notes?: string | null;
  meetLink?: string | null;
  serviceName: string;
  staffName: string;
  staffUserId?: string;
};

export default function AppointmentDrawer({
  booking,
  timezone,
  onClose,
  onChanged,
  canManage,
  canCancel = true,
}: {
  booking: DrawerBooking | null;
  timezone: string;
  onClose: () => void;
  onChanged?: (next: DrawerBooking) => void;
  canManage: boolean;
  /** Tenant feature toggle (cancellations). When false the Cancel
   *  action is hidden; the API would 403 the request anyway. */
  canCancel?: boolean;
}) {
  const [busy, setBusy] = React.useState(false);

  async function setStatus(status: Status) {
    if (!booking) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/bookings/${booking.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      toast(`Marked ${STATUS_LABEL[status].toLowerCase()}`, "success");
      onChanged?.({ ...booking, status });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!booking) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/bookings/${booking.id}/cancel`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      toast("Booking cancelled", "success");
      onChanged?.({ ...booking, status: "cancelled" });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  }

  const open = Boolean(booking);

  return (
    <Drawer open={open} onClose={onClose} side="right" ariaLabel="Appointment details">
      {booking && (
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between border-b border-border p-5">
            <div>
              <Badge className={STATUS_BADGE[booking.status]}>{STATUS_LABEL[booking.status]}</Badge>
              <h2 className="mt-2 text-lg font-semibold text-ink">{booking.serviceName}</h2>
              <p className="text-sm text-ink-muted">with {booking.staffName}</p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 -mt-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-inset hover:text-ink"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden>
                <path d="M6 6l12 12M6 18L18 6" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="flex-1 space-y-5 overflow-y-auto p-5 text-sm">
            <Section title="When">
              <div className="font-medium text-ink">
                {formatInTimeZone(booking.startAt, timezone, "EEEE, MMMM d")}
              </div>
              <div className="text-ink-muted">
                {formatInTimeZone(booking.startAt, timezone, "h:mm a")} –{" "}
                {formatInTimeZone(booking.endAt, timezone, "h:mm a zzz")}
              </div>
            </Section>

            <Section title="Client">
              <div className="font-medium text-ink">{booking.clientName}</div>
              <a className="text-brand-accent hover:underline" href={`mailto:${booking.clientEmail}`}>
                {booking.clientEmail}
              </a>
            </Section>

            {booking.meetLink && (
              <Section title="Video">
                <a
                  className="inline-flex items-center gap-1 text-brand-accent hover:underline"
                  href={booking.meetLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Google Meet
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden>
                    <path d="M7 17L17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </a>
              </Section>
            )}

            {booking.notes && (
              <Section title="Notes">
                <p className="whitespace-pre-line text-ink">{booking.notes}</p>
              </Section>
            )}
          </div>

          {canManage && (
            <div className="border-t border-border p-4">
              <div className="flex flex-wrap gap-1.5">
                {booking.status === "confirmed" && (
                  <>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => setStatus("completed")}>
                      Complete
                    </Button>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => setStatus("no_show")}>
                      No-show
                    </Button>
                    {canCancel && (
                      <Button variant="danger" size="sm" disabled={busy} onClick={cancel}>
                        Cancel
                      </Button>
                    )}
                  </>
                )}
                {booking.status === "cancelled" && (
                  <span className="text-xs text-ink-muted">No further actions on cancelled bookings.</span>
                )}
                {(booking.status === "completed" || booking.status === "no_show") && (
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => setStatus("confirmed")}>
                    Re-confirm
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">{title}</div>
      {children}
    </div>
  );
}

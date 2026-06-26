"use client";

/**
 * AppointmentDrawer — Apple-quality slide-over for booking details
 * (Phase 4E refinement).
 *
 * STRICTLY PRESERVED (do not change):
 *   - Default export name + props
 *   - DrawerBooking shape
 *   - setStatus() POST to /api/bookings/[id]/status
 *   - cancel()    POST to /api/bookings/[id]/cancel
 *   - onChanged() callback contract
 *   - Drawer primitive shell (slide-over mechanics)
 *
 * Visual refinement only:
 *   - Brand-gradient hero block with status pill + service title +
 *     staff sub + relative-time chip
 *   - "When" meta-card with day-of-week, time range, and timezone
 *   - "Client" card with AvatarChip + email link + mailto affordance
 *   - Premium "Join meeting" CTA button (brand-gradient) when a
 *     meetLink is present
 *   - "AI summary" InsightCard placeholder (post-booking notes slot)
 *   - Cleaner action footer with primary/secondary grouping
 */
import * as React from "react";
import { formatInTimeZone } from "date-fns-tz";
import {
  X,
  Clock4,
  CalendarDays,
  Video,
  Phone,
  Mail,
  User,
  Copy,
  Check,
  CheckCircle2,
  XCircle,
  RotateCcw,
  ArrowRight,
  ExternalLink,
} from "lucide-react";

import { Drawer, toast, confirmAction } from "@/components/ui/primitives";
import { InsightCard } from "@/components/ui/Card";
import { STATUS_LABEL, STATUS_DOT, type Status } from "@/lib/status-colors";
import { cn } from "@/lib/cn";
import { appointmentDeliveryDisplay } from "@/lib/appointment-delivery-display";

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
  const [emailCopied, setEmailCopied] = React.useState(false);
  // Phone-appointment work — deliveryMode + clientPhone aren't in the
  // server-rendered list rows, so fetch them from the detail read route
  // (GET /api/bookings/[id]) when the drawer opens. Non-fatal: any failure
  // leaves `delivery` null, so the badge/Call simply don't render (the rest of
  // the drawer is unchanged — old deliveryMode=null bookings look identical).
  const [delivery, setDelivery] = React.useState<{
    deliveryMode: string | null;
    clientPhone: string | null;
  } | null>(null);

  const bookingId = booking?.id ?? null;
  React.useEffect(() => {
    if (!bookingId) {
      setDelivery(null);
      return;
    }
    let cancelled = false;
    setDelivery(null);
    fetch(`/api/bookings/${bookingId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setDelivery({
          deliveryMode: d.deliveryMode ?? null,
          clientPhone: d.clientPhone ?? null,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  const deliveryDisplay = appointmentDeliveryDisplay(
    delivery?.deliveryMode,
    delivery?.clientPhone,
  );

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
    const ok = await confirmAction({
      title: "Cancel this appointment?",
      body: `${booking.clientName} will be notified by email. This action can't be undone.`,
      variant: "danger",
      confirmLabel: "Cancel appointment",
      cancelLabel: "Keep it",
    });
    if (!ok) return;
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

  function copyEmail() {
    if (!booking) return;
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(booking.clientEmail).then(
      () => {
        setEmailCopied(true);
        setTimeout(() => setEmailCopied(false), 1500);
      },
      () => toast("Couldn't copy", "error"),
    );
  }

  const open = Boolean(booking);

  return (
    <Drawer open={open} onClose={onClose} side="right" size="lg" ariaLabel="Appointment details">
      {booking && (
        <div className="flex h-full flex-col bg-surface">
          {/* ── Hero ─────────────────────────────────────────────── */}
          <div className="relative overflow-hidden border-b border-border/70 bg-gradient-to-br from-brand-subtle/55 via-surface to-surface px-5 pb-5 pt-5">
            {/* Soft corner glow */}
            <div
              aria-hidden
              className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl"
            />

            <div className="relative flex items-start justify-between">
              <div className="min-w-0">
                <StatusPill status={booking.status} />
                <h2 className="mt-2 truncate text-[18px] font-semibold tracking-tight text-ink">
                  {booking.serviceName}
                </h2>
                <p className="mt-0.5 text-[12px] text-ink-muted">
                  with <span className="font-medium text-ink">{booking.staffName}</span>
                </p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-inset hover:text-ink"
              >
                <X className="h-4 w-4" strokeWidth={2} />
              </button>
            </div>

            {/* Relative-time chip + duration */}
            <div className="relative mt-3 flex flex-wrap items-center gap-1.5">
              <RelativeTimeChip startAt={booking.startAt} />
              <DurationChip startAt={booking.startAt} endAt={booking.endAt} />
              {deliveryDisplay.badgeLabel && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1",
                    delivery?.deliveryMode === "phone"
                      ? "bg-emerald-50 text-emerald-700 ring-emerald-200/60"
                      : "bg-surface/80 text-ink-muted ring-border/70",
                  )}
                >
                  {delivery?.deliveryMode === "phone" && (
                    <Phone className="h-2.5 w-2.5" strokeWidth={2} />
                  )}
                  {deliveryDisplay.badgeLabel}
                </span>
              )}
            </div>
          </div>

          {/* ── Body ────────────────────────────────────────────── */}
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {/* When */}
            <MetaCard icon={CalendarDays} title="When">
              <div className="text-[13px] font-semibold text-ink">
                {formatInTimeZone(booking.startAt, timezone, "EEEE, MMMM d")}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-muted">
                <Clock4 className="h-3 w-3" strokeWidth={1.75} />
                <span className="tabular-nums">
                  {formatInTimeZone(booking.startAt, timezone, "h:mm a")}
                </span>
                <span>–</span>
                <span className="tabular-nums">
                  {formatInTimeZone(booking.endAt, timezone, "h:mm a")}
                </span>
                <span className="text-ink-subtle">·</span>
                <span className="text-ink-subtle">
                  {formatInTimeZone(booking.endAt, timezone, "zzz")}
                </span>
              </div>
            </MetaCard>

            {/* Client */}
            <MetaCard icon={User} title="Client">
              <div className="flex items-center gap-3">
                <AvatarChip name={booking.clientName} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-ink">
                    {booking.clientName}
                  </div>
                  <a
                    className="inline-flex items-center gap-1 text-[12px] text-brand-accent transition-colors hover:text-brand-hover"
                    href={`mailto:${booking.clientEmail}`}
                  >
                    <Mail className="h-3 w-3" strokeWidth={1.75} />
                    {booking.clientEmail}
                  </a>
                  {/* Phone-appointment work — Call Client action (tel: link).
                      Only shown when the booking is a phone appointment with a
                      dialable number. */}
                  {deliveryDisplay.callHref && (
                    <a
                      className="mt-0.5 flex items-center gap-1 text-[12px] font-medium text-emerald-700 transition-colors hover:text-emerald-800"
                      href={deliveryDisplay.callHref}
                      aria-label={`Call client at ${deliveryDisplay.phone}`}
                    >
                      <Phone className="h-3 w-3" strokeWidth={1.75} />
                      Call {deliveryDisplay.phone}
                    </a>
                  )}
                </div>
                <button
                  type="button"
                  onClick={copyEmail}
                  aria-label="Copy email"
                  className={cn(
                    "inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-surface text-ink-muted transition-colors",
                    emailCopied ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "hover:bg-surface-inset hover:text-ink",
                  )}
                >
                  {emailCopied ? <Check className="h-3.5 w-3.5" strokeWidth={2.25} /> : <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />}
                </button>
              </div>
            </MetaCard>

            {/* Video / Join */}
            {booking.meetLink && (
              <MetaCard icon={Video} title="Meeting">
                <a
                  href={booking.meetLink}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="group inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(37,99,235,0.35)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(37,99,235,0.45)]"
                >
                  <Video className="h-3.5 w-3.5" strokeWidth={2} />
                  Join meeting
                  <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" strokeWidth={2.25} />
                </a>
                <div className="mt-2 truncate text-[11px] text-ink-subtle">
                  <ExternalLink className="mr-1 inline-block h-2.5 w-2.5" strokeWidth={1.75} />
                  {prettyMeetUrl(booking.meetLink)}
                </div>
              </MetaCard>
            )}

            {/* Notes */}
            {booking.notes && (
              <MetaCard icon={null} title="Notes">
                <p className="whitespace-pre-line text-[12px] leading-relaxed text-ink">
                  {booking.notes}
                </p>
              </MetaCard>
            )}

            {/* AI summary placeholder — future-state slot for an
                automated summary once the meeting completes. */}
            <InsightCard title="AI summary">
              {booking.status === "completed"
                ? "Meeting summary will appear here once notes are processed."
                : "Meeting hasn't happened yet. Notes and a short summary will appear here after the session."}
            </InsightCard>
          </div>

          {/* ── Actions footer ────────────────────────────────────── */}
          {canManage && (
            <div className="border-t border-border/70 bg-surface-subtle/40 px-5 py-3.5">
              <ActionFooter
                status={booking.status}
                busy={busy}
                canCancel={canCancel}
                onComplete={() => setStatus("completed")}
                onNoShow={() => setStatus("no_show")}
                onReconfirm={() => setStatus("confirmed")}
                onCancel={cancel}
              />
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────

function StatusPill({ status }: { status: Status }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
      <span className={cn("inline-flex h-1.5 w-1.5 rounded-full", STATUS_DOT[status])} />
      {STATUS_LABEL[status]}
    </span>
  );
}

function RelativeTimeChip({ startAt }: { startAt: string }) {
  const [label, setLabel] = React.useState(() => formatRelative(startAt));
  React.useEffect(() => {
    const t = setInterval(() => setLabel(formatRelative(startAt)), 30_000);
    return () => clearInterval(t);
  }, [startAt]);
  return (
    <span className="zm-pulse-glow inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-brand-accent to-brand-hover px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white shadow-[0_4px_10px_rgba(37,99,235,0.3)]">
      <span className="h-1 w-1 rounded-full bg-white/90" />
      {label}
    </span>
  );
}

function DurationChip({ startAt, endAt }: { startAt: string; endAt: string }) {
  const minutes = Math.max(0, Math.round((new Date(endAt).getTime() - new Date(startAt).getTime()) / 60_000));
  const label = minutes >= 60
    ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
    : `${minutes}m`;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted ring-1 ring-border/70 backdrop-blur-sm">
      <Clock4 className="h-2.5 w-2.5" strokeWidth={2} />
      {label}
    </span>
  );
}

function MetaCard({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }> | null;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-surface p-3.5 shadow-soft">
      <div className="mb-2 flex items-center gap-1.5">
        {Icon && (
          <div className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-surface-inset text-ink-subtle">
            <Icon className="h-3 w-3" strokeWidth={1.75} />
          </div>
        )}
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          {title}
        </span>
      </div>
      <div>{children}</div>
    </div>
  );
}

function AvatarChip({ name }: { name: string }) {
  return (
    <div
      aria-hidden
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-[12px] font-semibold uppercase tracking-wider text-white shadow-sm"
    >
      {customerInitials(name)}
    </div>
  );
}

function ActionFooter({
  status,
  busy,
  canCancel,
  onComplete,
  onNoShow,
  onReconfirm,
  onCancel,
}: {
  status: Status;
  busy: boolean;
  canCancel: boolean;
  onComplete: () => void;
  onNoShow: () => void;
  onReconfirm: () => void;
  onCancel: () => void;
}) {
  if (status === "cancelled" || status === "refunded") {
    return (
      <div className="text-[11px] text-ink-muted">
        No further actions on cancelled bookings.
      </div>
    );
  }
  if (status === "completed" || status === "no_show") {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={onReconfirm}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md disabled:opacity-50"
      >
        <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
        Re-confirm
      </button>
    );
  }
  // confirmed / pending / pending_payment / payment_failed
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={onComplete}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(37,99,235,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(37,99,235,0.45)] disabled:opacity-50"
        >
          <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
          Mark complete
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onNoShow}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-800 hover:shadow-md disabled:opacity-50"
        >
          <XCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
          No-show
        </button>
      </div>
      {canCancel && (
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:border-red-300 hover:bg-red-50 hover:text-red-700 hover:shadow-md disabled:opacity-50"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

// ─── helpers ──────────────────────────────────────────────────────

function customerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatRelative(startAt: string): string {
  const startMs = new Date(startAt).getTime();
  const now = Date.now();
  const diff = startMs - now;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  if (min < 1) return "now";
  if (min < 60) return diff >= 0 ? `in ${min}m` : `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return diff >= 0 ? `in ${hr}h` : `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 7) return diff >= 0 ? `in ${days}d` : `${days}d ago`;
  const weeks = Math.round(days / 7);
  return diff >= 0 ? `in ${weeks}w` : `${weeks}w ago`;
}

function prettyMeetUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, "");
    return `${u.hostname}${path ? "/" + path : ""}`;
  } catch {
    return url;
  }
}

// Re-exported so existing call sites that import { type DrawerBooking }
// continue to type-check.
export type { Status };

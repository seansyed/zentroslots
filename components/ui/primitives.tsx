"use client";

import * as React from "react";
import Link from "next/link";

// ─── Button ─────────────────────────────────────────────────────────────

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand-accent text-white hover:bg-brand-hover shadow-xs",
  secondary: "border border-border bg-surface text-ink hover:bg-surface-inset",
  ghost: "text-ink-muted hover:bg-surface-inset hover:text-ink",
  danger: "border border-red-200 bg-surface text-red-700 hover:bg-red-50",
};

const BUTTON_SIZES = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
  lg: "px-4 py-2 text-sm",
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: keyof typeof BUTTON_SIZES;
}) {
  return (
    <button
      {...rest}
      className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`}
    />
  );
}

// ─── Card ───────────────────────────────────────────────────────────────

export function Card({ className = "", children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`rounded-xl border border-border bg-surface p-5 shadow-xs ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h3 className="text-base font-medium text-ink">{title}</h3>
      {subtitle && <p className="mt-0.5 text-sm text-ink-muted">{subtitle}</p>}
    </div>
  );
}

// ─── Skeleton ───────────────────────────────────────────────────────────

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface-inset ${className}`} aria-hidden />;
}

// ─── EmptyState ─────────────────────────────────────────────────────────

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className="rounded-xl border border-dashed border-border bg-surface p-10 text-center shadow-xs"
    >
      <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface-inset text-ink-subtle" aria-hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
          <circle cx="12" cy="12" r="9" />
          <path d="M9 12h6M12 9v6" />
        </svg>
      </div>
      <div className="text-sm font-medium text-ink">{title}</div>
      {body && <p className="mt-1 text-sm text-ink-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ─── Modal ──────────────────────────────────────────────────────────────

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-surface p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h2 className="text-lg font-semibold text-ink">{title}</h2>}
        <div className={title ? "mt-3" : ""}>{children}</div>
      </div>
    </div>
  );
}

// ─── Drawer (slide-in operational workspace) ────────────────────────────
//
// Sized for the operational role it plays:
//
//   default   — 288px hard width. Mobile sidebar nav use case (Shell).
//               Stays 288px even on narrow phones; backward-compatible.
//   lg        — up to 440px. Focused detail drawers (appointment,
//               delivery log).
//   xl        — up to 600px. Task workspaces (assign staff, share
//               service).
//   workspace — up to 680px. Rich multi-section workspaces with
//               tabs (staff profile, service editor, customer profile).
//
// All non-default sizes use w-full on mobile so they fill the viewport
// on phones; they cap at their max width on tablet/desktop so the
// canvas behind the drawer stays visible and the workspace feels
// like a side workspace, not a takeover. Motion stays on the
// ease-out-expo curve (cubic-bezier(0.16, 1, 0.3, 1)).

export type DrawerSize = "default" | "lg" | "xl" | "workspace";

const DRAWER_SIZE_CLASSES: Record<DrawerSize, string> = {
  default:   "w-72",
  lg:        "w-full max-w-[440px]",
  xl:        "w-full max-w-[600px]",
  workspace: "w-full max-w-[680px]",
};

export function Drawer({
  open,
  onClose,
  side = "right",
  size = "default",
  children,
  ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  side?: "left" | "right";
  size?: DrawerSize;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  return (
    <>
      <div
        className={
          "fixed inset-0 z-40 bg-black/30 transition-opacity duration-300 ease-out-expo " +
          (open ? "opacity-100" : "pointer-events-none opacity-0")
        }
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={
          "fixed top-0 z-50 flex h-full flex-col bg-surface shadow-lg transition-transform duration-300 ease-out-expo " +
          DRAWER_SIZE_CLASSES[size] + " " +
          (side === "right" ? "right-0 " : "left-0 ") +
          (open
            ? "translate-x-0"
            : side === "right" ? "translate-x-full" : "-translate-x-full")
        }
      >
        {children}
      </aside>
    </>
  );
}

// ─── Badge / Status Pill ────────────────────────────────────────────────

type BadgeTone = "neutral" | "blue" | "green" | "amber" | "red" | "violet";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-inset text-ink-muted border-border",
  blue:    "bg-blue-50 text-blue-700 border-blue-200",
  green:   "bg-green-50 text-green-700 border-green-200",
  amber:   "bg-amber-50 text-amber-800 border-amber-200",
  red:     "bg-red-50 text-red-700 border-red-200",
  violet:  "bg-violet-50 text-violet-700 border-violet-200",
};

export function Badge({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium " +
        BADGE_TONES[tone] +
        " " +
        className
      }
    >
      {children}
    </span>
  );
}

// ─── Tabs (URL-driven, link-based, server-friendly) ─────────────────────

export function Tabs({
  items,
  current,
}: {
  items: { label: string; href: string; count?: number }[];
  current: string;
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-border">
      {items.map((it) => {
        const active = it.href === current;
        return (
          <Link
            key={it.href}
            href={it.href}
            role="tab"
            aria-selected={active}
            className={
              "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition " +
              (active
                ? "border-brand-accent font-medium text-brand-accent"
                : "border-transparent text-ink-muted hover:text-ink")
            }
          >
            {it.label}
            {typeof it.count === "number" && (
              <span className="rounded-md bg-surface-inset px-1.5 py-0.5 text-[10px] text-ink-muted">
                {it.count}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

// ─── Avatar + AvatarGroup ───────────────────────────────────────────────
//
// The Avatar primitive lives in `./Avatar.tsx` so it can be used
// independently and so its premium states (image fade-in, initials
// gradient, xs/xl sizes) can evolve without churning this barrel.
// Re-exported here so existing callers
// (`import { Avatar } from "@/components/ui/primitives"`) keep working.
import { Avatar } from "./Avatar";
export { Avatar };

export function AvatarGroup({
  members,
  max = 4,
  size = "sm",
}: {
  members: { name: string; src?: string | null }[];
  max?: number;
  size?: "sm" | "md" | "lg";
}) {
  const visible = members.slice(0, max);
  const extra = members.length - visible.length;
  return (
    <div className="inline-flex -space-x-2">
      {visible.map((m, i) => (
        <Avatar key={i} {...m} size={size} className="ring-2 ring-surface" />
      ))}
      {extra > 0 && (
        <div
          className={
            "inline-flex items-center justify-center rounded-full bg-surface-inset text-ink-muted ring-2 ring-surface " +
            (size === "sm" ? "h-6 w-6 text-[10px]" : size === "md" ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm")
          }
        >
          +{extra}
        </div>
      )}
    </div>
  );
}

// ─── Breadcrumb ─────────────────────────────────────────────────────────

export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-ink-muted">
      {items.map((it, i) => (
        <React.Fragment key={`${i}:${it.label}`}>
          {i > 0 && <span className="text-ink-subtle">/</span>}
          {it.href ? (
            <Link href={it.href} className="hover:text-ink">{it.label}</Link>
          ) : (
            <span className="text-ink">{it.label}</span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}

// ─── Tooltip (CSS-only, no JS) ──────────────────────────────────────────
// Keeps things light; for richer behaviour we can adopt @radix-ui later.

export function Tooltip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-ink px-2 py-1 text-[11px] text-ink-inverted opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}

// ─── Toast (singleton) ──────────────────────────────────────────────────

type ToastKind = "success" | "error" | "info";
type ToastItem = { id: number; kind: ToastKind; message: string };

let listeners: Array<(items: ToastItem[]) => void> = [];
let items: ToastItem[] = [];
let nextId = 1;

function emit() {
  for (const l of listeners) l(items);
}

export function toast(message: string, kind: ToastKind = "info") {
  const item: ToastItem = { id: nextId++, kind, message };
  items = [...items, item];
  emit();
  setTimeout(() => {
    items = items.filter((i) => i.id !== item.id);
    emit();
  }, 4000);
}

export function ToastHost() {
  const [list, setList] = React.useState<ToastItem[]>(items);
  React.useEffect(() => {
    listeners.push(setList);
    return () => {
      listeners = listeners.filter((l) => l !== setList);
    };
  }, []);
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2"
      aria-live="polite"
    >
      {list.map((i) => (
        <div
          key={i.id}
          role="status"
          className={
            "pointer-events-auto max-w-sm rounded-md border px-4 py-2 text-sm shadow-md " +
            (i.kind === "success"
              ? "border-green-200 bg-green-50 text-green-800"
              : i.kind === "error"
                ? "border-red-200 bg-red-50 text-red-800"
                : "border-border bg-surface text-ink")
          }
        >
          {i.message}
        </div>
      ))}
    </div>
  );
}

// ─── Confirm dialog (singleton, promise-based) ──────────────────────────
//
// Premium, branded replacement for window.confirm(). Returns a Promise
// that resolves to `true` if the user confirms, `false` otherwise.
//
// Usage:
//   if (!(await confirmAction({
//     title: "Cancel appointment?",
//     body: "The customer will be notified by email.",
//     variant: "danger",
//     confirmLabel: "Cancel appointment",
//     cancelLabel: "Keep it",
//   }))) return;
//
// Mount <ConfirmHost /> once at the root layout (alongside <ToastHost />).
// All confirmAction calls anywhere in the app render through it.

export type ConfirmVariant = "danger" | "warning" | "info";

export type ConfirmOptions = {
  /** Required short heading (≤ ~60 chars). */
  title: string;
  /** Optional supporting text (≤ ~280 chars). Plain string, line breaks honored. */
  body?: string;
  /** Visual tone. Defaults to "warning". */
  variant?: ConfirmVariant;
  /** Primary action label. Defaults to a tone-appropriate verb. */
  confirmLabel?: string;
  /** Secondary action label. Defaults to "Cancel". */
  cancelLabel?: string;
};

type ConfirmRequest = ConfirmOptions & {
  id: number;
  resolve: (ok: boolean) => void;
};

let confirmListeners: Array<(req: ConfirmRequest | null) => void> = [];
let confirmCurrent: ConfirmRequest | null = null;
let confirmNextId = 1;

function emitConfirm() {
  for (const l of confirmListeners) l(confirmCurrent);
}

/**
 * Show a premium confirm dialog. Resolves to true if the user confirms,
 * false if they cancel or dismiss (Esc, backdrop click).
 *
 * Safe to call before <ConfirmHost /> mounts — the request queues and
 * renders once the host appears.
 */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  // If a confirm is already open, reject the new one rather than
  // stacking. Caller can always retry once the user resolves the
  // current dialog.
  return new Promise<boolean>((resolve) => {
    const req: ConfirmRequest = {
      ...opts,
      id: confirmNextId++,
      resolve,
    };
    confirmCurrent = req;
    emitConfirm();
  });
}

const VARIANT_TONES: Record<
  ConfirmVariant,
  {
    iconBg: string;
    iconRing: string;
    iconColor: string;
    glow: string;
    confirmBg: string;
    confirmHover: string;
    confirmShadow: string;
    defaultConfirmLabel: string;
  }
> = {
  danger: {
    iconBg: "bg-gradient-to-br from-rose-50 to-rose-100/70",
    iconRing: "ring-rose-200/80",
    iconColor: "text-rose-600",
    glow: "bg-rose-400/15",
    confirmBg: "bg-gradient-to-b from-rose-500 to-rose-600",
    confirmHover: "hover:from-rose-500 hover:to-rose-700",
    confirmShadow:
      "shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_8px_22px_-8px_rgba(244,63,94,0.55)]",
    defaultConfirmLabel: "Delete",
  },
  warning: {
    iconBg: "bg-gradient-to-br from-amber-50 to-amber-100/70",
    iconRing: "ring-amber-200/80",
    iconColor: "text-amber-600",
    glow: "bg-amber-400/15",
    confirmBg: "bg-gradient-to-b from-amber-500 to-amber-600",
    confirmHover: "hover:from-amber-500 hover:to-amber-700",
    confirmShadow:
      "shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_8px_22px_-8px_rgba(245,158,11,0.55)]",
    defaultConfirmLabel: "Continue",
  },
  info: {
    iconBg: "bg-gradient-to-br from-sky-50 to-sky-100/70",
    iconRing: "ring-sky-200/80",
    iconColor: "text-sky-600",
    glow: "bg-sky-400/15",
    confirmBg: "bg-gradient-to-b from-sky-500 to-sky-600",
    confirmHover: "hover:from-sky-500 hover:to-sky-700",
    confirmShadow:
      "shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_8px_22px_-8px_rgba(56,124,225,0.55)]",
    defaultConfirmLabel: "OK",
  },
};

export function ConfirmHost() {
  const [req, setReq] = React.useState<ConfirmRequest | null>(confirmCurrent);
  const confirmBtnRef = React.useRef<HTMLButtonElement | null>(null);

  // Subscribe to the singleton event stream
  React.useEffect(() => {
    confirmListeners.push(setReq);
    return () => {
      confirmListeners = confirmListeners.filter((l) => l !== setReq);
    };
  }, []);

  // Focus the confirm button on open + handle Escape to cancel
  React.useEffect(() => {
    if (!req) return;
    // Defer focus to next frame so animation start doesn't compete
    const t = window.setTimeout(() => confirmBtnRef.current?.focus(), 50);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        resolve(false);
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        resolve(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req?.id]);

  // Lock body scroll while open
  React.useEffect(() => {
    if (!req) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [req?.id]);

  if (!req) return null;

  const variant: ConfirmVariant = req.variant ?? "warning";
  const tone = VARIANT_TONES[variant];
  const confirmLabel = req.confirmLabel ?? tone.defaultConfirmLabel;
  const cancelLabel = req.cancelLabel ?? "Cancel";

  function resolve(ok: boolean) {
    if (!confirmCurrent || confirmCurrent.id !== req!.id) return;
    const r = confirmCurrent;
    confirmCurrent = null;
    emitConfirm();
    r.resolve(ok);
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="zm-confirm-title"
      aria-describedby={req.body ? "zm-confirm-body" : undefined}
      className="zm-confirm-overlay fixed inset-0 z-[100] flex items-end justify-center bg-slate-900/40 px-4 pb-6 pt-10 backdrop-blur-[3px] sm:items-center sm:p-6"
      onClick={(e) => {
        // Backdrop click → cancel
        if (e.target === e.currentTarget) resolve(false);
      }}
    >
      <div className="zm-confirm-card relative w-full max-w-md overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-0 text-left shadow-[0_1px_0_rgba(255,255,255,0.9)_inset,0_1px_3px_rgba(15,23,42,0.04),0_12px_36px_-10px_rgba(15,23,42,0.18),0_24px_56px_-24px_rgba(15,23,42,0.22)]">
        {/* Top accent glow */}
        <div
          aria-hidden
          className={`pointer-events-none absolute -top-16 left-1/2 h-32 w-32 -translate-x-1/2 rounded-full ${tone.glow} blur-2xl`}
        />

        <div className="relative p-6 sm:p-7">
          <div className="flex items-start gap-4">
            <div
              className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ${tone.iconBg} ${tone.iconRing}`}
            >
              <ConfirmIcon variant={variant} className={`h-5 w-5 ${tone.iconColor}`} />
            </div>
            <div className="min-w-0 flex-1">
              <h2
                id="zm-confirm-title"
                className="text-[15px] font-semibold leading-snug tracking-tight text-slate-900"
              >
                {req.title}
              </h2>
              {req.body ? (
                <p
                  id="zm-confirm-body"
                  className="mt-1.5 whitespace-pre-line text-[13.5px] leading-relaxed text-slate-600"
                >
                  {req.body}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-2.5">
            <button
              type="button"
              onClick={() => resolve(false)}
              className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-300/90 bg-white px-4 text-[13.5px] font-medium text-slate-700 shadow-[0_1px_0_rgba(255,255,255,0.7)_inset,0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-150 hover:border-slate-400/80 hover:bg-slate-50/70 hover:text-slate-900 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/40 focus-visible:ring-offset-2"
            >
              {cancelLabel}
            </button>
            <button
              ref={confirmBtnRef}
              type="button"
              onClick={() => resolve(true)}
              className={`group inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-[13.5px] font-medium text-white transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${tone.confirmBg} ${tone.confirmHover} ${tone.confirmShadow} ${
                variant === "danger"
                  ? "focus-visible:ring-rose-400/50"
                  : variant === "warning"
                    ? "focus-visible:ring-amber-400/50"
                    : "focus-visible:ring-sky-400/50"
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes zm-confirm-fade { 0% { opacity: 0; } 100% { opacity: 1; } }
        @keyframes zm-confirm-rise {
          0% { opacity: 0; transform: translateY(8px) scale(0.985); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        .zm-confirm-overlay { animation: zm-confirm-fade 160ms ease-out both; }
        .zm-confirm-card { animation: zm-confirm-rise 220ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        @media (prefers-reduced-motion: reduce) {
          .zm-confirm-overlay, .zm-confirm-card { animation: none; }
        }
      `}</style>
    </div>
  );
}

function ConfirmIcon({
  variant,
  className = "",
}: {
  variant: ConfirmVariant;
  className?: string;
}) {
  if (variant === "info") {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
    );
  }
  if (variant === "danger") {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
      </svg>
    );
  }
  // warning
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

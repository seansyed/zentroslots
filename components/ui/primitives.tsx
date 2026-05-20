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

"use client";

import * as React from "react";
import Link from "next/link";

import { Tooltip } from "@/components/ui/primitives";
import ThemeToggle from "./ThemeToggle";
import NotificationBell from "./NotificationBell";
import CommandPalette, { CommandPaletteTrigger, useCommandPalette } from "./CommandPalette";

type Crumb = { label: string; href?: string };

export default function Topbar({
  title,
  subtitle,
  crumbs,
  actions,
  onOpenSidebar,
}: {
  title?: string;
  subtitle?: string;
  crumbs?: Crumb[];
  actions?: React.ReactNode;
  onOpenSidebar?: () => void;
}) {
  const cmd = useCommandPalette();
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur-md sm:px-6">
      {onOpenSidebar && (
        <button
          type="button"
          aria-label="Open navigation"
          onClick={onOpenSidebar}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-muted hover:bg-surface-inset hover:text-ink lg:hidden"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden>
            <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
          </svg>
        </button>
      )}

      <div className="min-w-0 flex-1">
        {crumbs && crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="hidden text-xs text-ink-muted sm:flex sm:items-center sm:gap-1">
            {crumbs.map((c, i) => (
              <React.Fragment key={`${i}:${c.label}`}>
                {i > 0 && <span className="text-ink-subtle">/</span>}
                {c.href ? (
                  <Link href={c.href} className="hover:text-ink">{c.label}</Link>
                ) : (
                  <span className="text-ink">{c.label}</span>
                )}
              </React.Fragment>
            ))}
          </nav>
        )}
        {title && (
          <div className="flex items-baseline gap-2">
            <h1 className="truncate text-sm font-semibold text-ink sm:text-base">{title}</h1>
            {subtitle && <span className="hidden truncate text-xs text-ink-muted sm:inline">· {subtitle}</span>}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {actions}
        <CommandPaletteTrigger onOpen={cmd.open} />
        <NotificationBell />
        <ThemeToggle />
      </div>

      <CommandPalette open={cmd.isOpen} onClose={cmd.close} />
    </header>
  );
}

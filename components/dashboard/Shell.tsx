"use client";

import * as React from "react";
import Sidebar, { type SidebarUser, type SidebarTenant, type SidebarVariant } from "./Sidebar";
import Topbar from "./Topbar";
import { Drawer } from "@/components/ui/primitives";

export default function Shell({
  user,
  tenant,
  variant = "tenant",
  title,
  subtitle,
  crumbs,
  actions,
  children,
}: {
  user: SidebarUser;
  tenant?: SidebarTenant;
  variant?: SidebarVariant;
  title?: string;
  subtitle?: string;
  crumbs?: { label: string; href?: string }[];
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // Inject the tenant's accent color into the page so all
  // `text-brand-accent` / `bg-brand-accent` classes pick it up
  // without rebuilding Tailwind.
  React.useEffect(() => {
    if (!tenant) return;
    // The actual color comes via the page already setting it on body if
    // it wants per-tenant override — for the shell we just leave defaults.
  }, [tenant]);

  return (
    <div className="flex min-h-screen bg-surface-subtle text-ink">
      {/* Desktop sidebar */}
      <aside
        className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-border bg-surface lg:flex lg:flex-col"
        aria-label="Sidebar"
      >
        <Sidebar user={user} tenant={tenant} variant={variant} />
      </aside>

      {/* Mobile sidebar drawer */}
      <Drawer open={mobileOpen} onClose={() => setMobileOpen(false)} side="left" ariaLabel="Navigation">
        <Sidebar user={user} tenant={tenant} variant={variant} />
      </Drawer>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          title={title}
          subtitle={subtitle}
          crumbs={crumbs}
          actions={actions}
          onOpenSidebar={() => setMobileOpen(true)}
        />
        <main className="flex-1">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

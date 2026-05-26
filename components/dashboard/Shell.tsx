"use client";

import * as React from "react";
import Sidebar, {
  type SidebarUser,
  type SidebarTenant,
  type SidebarVariant,
  useSidebarCollapsed,
} from "./Sidebar";
import Topbar from "./Topbar";
import GlobalCopilot from "./GlobalCopilot";
import CommandPalette from "@/components/admin/CommandPalette";
import { Drawer } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

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
  const [collapsed, setCollapsed] = useSidebarCollapsed();

  return (
    <div className="flex min-h-screen bg-surface-subtle text-ink">
      {/* Desktop sidebar — width adapts to collapsed state */}
      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 border-r border-border bg-surface transition-[width] duration-200 ease-out lg:flex lg:flex-col",
          collapsed ? "w-[64px]" : "w-[260px]"
        )}
        aria-label="Sidebar"
      >
        <Sidebar
          user={user}
          tenant={tenant}
          variant={variant}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed(!collapsed)}
        />
      </aside>

      {/* Mobile sidebar drawer (always expanded inside the drawer) */}
      <Drawer open={mobileOpen} onClose={() => setMobileOpen(false)} side="left" ariaLabel="Navigation">
        <Sidebar user={user} tenant={tenant} variant={variant} />
      </Drawer>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          title={title}
          subtitle={subtitle}
          crumbs={crumbs}
          actions={actions}
          user={user}
          onOpenSidebar={() => setMobileOpen(true)}
        />
        <main className="flex-1">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            {children}
          </div>
        </main>
      </div>

      {/* Phase 9A — persistent operational copilot. Mounted at the Shell
       *  level so it appears across every dashboard workspace (calendar,
       *  appointments, customers, communications, tasks, analytics).
       *  See components/dashboard/GlobalCopilot.tsx for the surface and
       *  app/api/tenant/copilot/brief/route.ts for the cross-module
       *  signal synthesis. */}
      <GlobalCopilot />

      {/* SA-9 — Global Command Palette (Cmd+K / Ctrl+K). Super-admin
       *  only — the palette item set is built for the /admin surface.
       *  Tenant-side cmd-K already exists inside CalendarView; this
       *  one targets cross-admin navigation, tenant lookup, and
       *  quick actions. */}
      {variant === "super" ? <CommandPalette /> : null}
    </div>
  );
}

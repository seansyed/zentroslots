"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Calendar,
  ListChecks,
  Bell,
  Users,
  UserRound,
  Briefcase,
  MapPin,
  Box,
  Clock,
  CalendarSync,
  BarChart3,
  Receipt,
  Mail,
  Palette,
  Plug,
  Sparkles,
  Flag,
  Repeat,
  Shield,
  ShieldCheck,
  ChevronsLeft,
  ChevronsRight,
  ChevronRight,
  LogOut,
  Activity,
  CreditCard,
  Megaphone,
  Settings2,
  GitBranch,
} from "lucide-react";

import { Avatar, Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { meetsPlan, type PlanId } from "@/lib/plans";

type Role = "admin" | "manager" | "staff" | "client";

export type SidebarVariant = "tenant" | "super";

export type SidebarUser = {
  name: string;
  email: string;
  role: Role;
  permissions?: Partial<Record<
    | "canViewExecutiveAnalytics"
    | "canManageAutomation"
    | "canExportReports"
    | "canManageSecurity"
    | "canViewAuditLogs",
    boolean
  >>;
};

export type SidebarTenant = {
  name: string;
  slug: string;
  plan?: string;
  logoUrl?: string | null;
};

type LucideIcon = React.ComponentType<{ className?: string; strokeWidth?: number }>;
type Item = {
  label: string;
  href: string;
  icon: LucideIcon;
  soon?: boolean;
  /** Phase 6 — UI lockdown. When true, render a "Pro" badge next to
   *  the label so users know the destination is a paid feature. The
   *  link still navigates (the destination page shows its own locked
   *  state); we don't hide the item entirely because Free tenants
   *  with grandfathered rows still need to reach the page to view
   *  their existing data read-only. */
  premium?: boolean;
};
type Group = {
  /** Stable id used as the localStorage key for collapsed state. */
  id: string;
  label?: string;
  items: Item[];
  /** When true, the group can be expanded/collapsed by the user. */
  collapsible?: boolean;
  /** Initial collapsed state if the user hasn't interacted. */
  collapsedByDefault?: boolean;
};

function buildNav(
  variant: SidebarVariant,
  role: Role,
  permissions?: SidebarUser["permissions"],
  /** Phase 6 — UI lockdown. Used to mark plan-gated nav items with a
   *  "Pro" badge so users see the tier requirement before clicking.
   *  When undefined, nothing is marked premium (back-compat).
   *  Strings outside the PlanId union are treated as "free" for the
   *  purpose of the comparison — fail-safe (badge shown). */
  plan?: string,
): Group[] {
  const planAsId = (plan ?? "free") as PlanId;
  // True when the tenant's plan does NOT meet Pro — used to mark
  // recurring_series, automation_rules, routing_rules, etc.
  const needsProUpgrade = !meetsPlan(planAsId, "pro");
  const flagOrRoleDefault = (
    flag: keyof NonNullable<SidebarUser["permissions"]>,
    fallback: boolean
  ): boolean => {
    if (permissions === undefined) return fallback;
    if (permissions[flag] !== undefined) return permissions[flag] === true;
    return fallback;
  };

  if (variant === "super") {
    return [
      {
        id: "super-platform",
        label: "Platform",
        items: [
          { label: "Overview",      href: "/admin",                          icon: LayoutDashboard },
          { label: "Tenants",       href: "/admin/tenants",                  icon: Briefcase },
          { label: "Intelligence",  href: "/admin/tenants/intelligence",     icon: ShieldCheck },
          { label: "Subscriptions", href: "/admin/subscriptions",            icon: CreditCard },
          { label: "Plans",         href: "/admin/plans",           icon: Box },
          { label: "Promotions",    href: "/admin/promotions",      icon: Flag },
          { label: "Announcements", href: "/admin/announcements",   icon: Megaphone },
        ],
      },
      {
        id: "super-ops",
        label: "Operations",
        items: [
          { label: "Revenue",       href: "/admin/revenue",         icon: BarChart3 },
          { label: "System health", href: "/admin/system-health",   icon: Activity },
          { label: "Audit logs",    href: "/admin#audit",           icon: ListChecks },
          // Legacy /admin/health page preserved for now — replaced
          // by /admin/system-health (SA-3) but the old URL still
          // resolves so any external bookmarks keep working.
        ],
      },
    ];
  }

  // tenant variant — Phase 3 restructure into 5 progressive-disclosure groups.
  const roleDefaults = {
    canViewExecutiveAnalytics: role === "admin" || role === "manager",
    canManageAutomation:       role === "admin" || role === "manager",
    canExportReports:          role === "admin" || role === "manager",
    canViewAuditLogs:          role === "admin" || role === "manager",
  };

  const operate: Item[] = [
    { label: "Dashboard",     href: "/dashboard",                icon: LayoutDashboard },
    { label: "Calendar",      href: "/dashboard/calendar",       icon: Calendar },
    { label: "Appointments",  href: "/dashboard/appointments",   icon: ListChecks },
    { label: "Tasks",         href: "/dashboard/tasks",          icon: Flag },
    { label: "Notifications", href: "/dashboard/notifications",  icon: Bell },
  ];

  const crm: Item[] = [
    { label: "Customers",   href: "/dashboard/customers",   icon: UserRound },
    { label: "Staff",       href: "/dashboard/staff",       icon: Users },
    ...(role === "admin"
      ? [{ label: "Departments", href: "/dashboard/departments", icon: Briefcase }]
      : []),
  ];

  const booking: Item[] = [
    { label: "Services",      href: "/dashboard/services",                icon: Box },
    ...(role === "admin"
      ? [{ label: "Locations", href: "/dashboard/locations", icon: MapPin }]
      : []),
    { label: "Working hours", href: "/dashboard/availability",            icon: Clock },
    { label: "Overrides",     href: "/dashboard/availability/overrides",  icon: Flag },
    { label: "Calendar infrastructure", href: "/dashboard/settings/calendar", icon: CalendarSync },
  ];

  const workspace: Item[] = [
    { label: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
    ...(flagOrRoleDefault("canViewExecutiveAnalytics", roleDefaults.canViewExecutiveAnalytics)
      ? [{ label: "Executive", href: "/dashboard/analytics/executive", icon: Sparkles }]
      : []),
    { label: "Reports", href: "/dashboard/reports", icon: Receipt },
    ...(role === "admin"
      ? [
          { label: "Email log",      href: "/dashboard/emails",                  icon: Mail },
          { label: "Communications", href: "/dashboard/settings/communications", icon: Mail },
          { label: "Billing",        href: "/dashboard/billing",                 icon: Receipt },
          // Wave H Phase 5 — tenant payment provider vault. Distinct
          // from "Billing" (platform subscription) — this is the
          // tenant's own Stripe/PayPal credentials for charging
          // their customers directly.
          { label: "Payments",       href: "/dashboard/settings/payments",       icon: CreditCard },
          { label: "Branding",       href: "/dashboard/settings/branding",       icon: Palette },
          { label: "Integrations",   href: "/dashboard/settings/integrations",   icon: Plug },
          { label: "Custom domain",  href: "/dashboard/settings/domain",         icon: Plug },
          { label: "Embed widget",   href: "/dashboard/settings/embed",          icon: Box },
        ]
      : []),
  ];

  const advanced: Item[] = [
    ...(role === "admin"
      ? [
          // Workforce Availability Intelligence Center now lives at
          // /dashboard/availability (sidebar "Working hours" entry).
          // The old standalone "Workspace hours" link was removed —
          // workspace defaults are edited inside the new page.
          { label: "Feature controls",       href: "/dashboard/settings/features",        icon: Settings2 },
          { label: "Staff routing",          href: "/dashboard/settings/routing",         icon: GitBranch },
          { label: "Booking rules",          href: "/dashboard/settings/booking-rules",   icon: Clock },
          // Wave I — reusable intake forms attachable to services.
          { label: "Intake forms",           href: "/dashboard/settings/intake-forms",    icon: ListChecks },
          { label: "Waitlists",              href: "/dashboard/settings/waitlists",       icon: Users },
          { label: "Recurring bookings",     href: "/dashboard/settings/recurring",       icon: Repeat,    premium: needsProUpgrade },
        ]
      : []),
    ...(flagOrRoleDefault("canManageAutomation", roleDefaults.canManageAutomation)
      ? [{ label: "Follow-up automations", href: "/dashboard/settings/automations", icon: Sparkles, premium: needsProUpgrade }]
      : []),
    { label: "Security", href: "/dashboard/settings/security", icon: Shield },
    ...(flagOrRoleDefault("canManageSecurity", role === "admin")
      ? [{ label: "Governance", href: "/dashboard/settings/governance", icon: ShieldCheck }]
      : []),
  ];

  // Operational Hardening Wave — admin-only "Operations" group for
  // observability + safety-net tools that aren't settings. Currently
  // holds Payment ops; future ops tools (sync inspectors, etc.) land
  // here too. Group is hidden entirely for non-admins.
  const operations: Item[] = role === "admin"
    ? [
        { label: "Payment ops", href: "/dashboard/operations/payments", icon: Activity },
      ]
    : [];

  const groups: Group[] = [
    { id: "operate",    label: "Operate",    items: operate },
    { id: "crm",        label: "CRM",        items: crm },
    { id: "booking",    label: "Booking",    items: booking },
    { id: "workspace",  label: "Workspace",  items: workspace },
    { id: "operations", label: "Operations", items: operations },
    {
      id: "advanced",
      label: "Advanced",
      items: advanced,
      collapsible: true,
      collapsedByDefault: true,
    },
  ];

  return groups.filter((g) => g.items.length > 0);
}

function isActive(href: string, pathname: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  if (href === "/admin") return pathname === "/admin";
  if (href.includes("?")) return false;
  if (href.includes("#")) return pathname === href.split("#")[0];
  return pathname === href || pathname.startsWith(href + "/");
}

// ─── Collapsed (sidebar-wide) state ─────────────────────────────────
const STORAGE_KEY = "zm:sidebar:collapsed";

export function useSidebarCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = React.useState<boolean>(false);
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "1") setCollapsed(true);
    } catch {
      /* ignore */
    }
  }, []);
  const set = React.useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);
  return [collapsed, set];
}

// ─── Per-group collapsed state ───────────────────────────────────────
function useGroupCollapsed(groupId: string, defaultCollapsed: boolean) {
  const key = `zm:sidebar:group:${groupId}`;
  const [collapsed, setCollapsed] = React.useState<boolean>(defaultCollapsed);
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored === "1") setCollapsed(true);
      else if (stored === "0") setCollapsed(false);
    } catch {
      /* ignore */
    }
  }, [key]);
  const toggle = React.useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [key]);
  return [collapsed, toggle] as const;
}

export default function Sidebar({
  user,
  tenant,
  variant = "tenant",
  collapsed = false,
  onToggleCollapsed,
}: {
  user: SidebarUser;
  tenant?: SidebarTenant;
  variant?: SidebarVariant;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const pathname = usePathname();
  const groups = buildNav(variant, user.role, user.permissions, tenant?.plan);

  // Phase 17I-5 — lazy-load the signed-in user's avatar URL from
  // /api/auth/me. The Shell's SidebarUser prop is server-rendered
  // and intentionally lean (name + email + role + permissions);
  // plumbing avatarUrl through 36 page.tsx callers would be invasive.
  // One client-side fetch on mount is the additive path. The Avatar
  // primitive falls back to initials while the request resolves OR
  // when no avatar has been uploaded.
  const [avatarUrl, setAvatarUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { avatarUrl?: string | null };
        if (!cancelled && data.avatarUrl) setAvatarUrl(data.avatarUrl);
      } catch {
        /* swallow — initials fallback already in place */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Workspace header */}
      <div className={cn("flex items-center border-b border-border", collapsed ? "h-16 justify-center px-2" : "h-16 px-4")}>
        <Link
          href={variant === "super" ? "/admin" : "/dashboard"}
          className={cn("flex min-w-0 items-center gap-3", collapsed && "justify-center")}
        >
          {tenant?.logoUrl ? (
            // Tenant-uploaded logo wins — workspace branding flow is
            // unchanged from Settings -> Branding.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={tenant.logoUrl} alt="" className="h-9 w-9 shrink-0 rounded-xl object-contain" />
          ) : (
            // Platform default: the ZentroMeet circular mark.
            // Replaces the prior single-letter gradient circle so
            // workspaces without custom branding still feel
            // on-brand instead of generic.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src="/zentromeet-mark.svg"
              alt="ZentroMeet"
              className="h-9 w-9 shrink-0 rounded-full object-contain shadow-sm"
            />
          )}
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold leading-tight tracking-tight text-ink">
                {tenant?.name ?? "ZentroMeet"}
              </div>
              {variant === "tenant" ? (
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
                  {tenant?.plan && (
                    <Badge tone={tenant.plan === "free" ? "neutral" : "blue"} className="h-4 px-1.5 text-[10px] capitalize">
                      {tenant.plan}
                    </Badge>
                  )}
                  {tenant?.slug && <span className="truncate">/u/{tenant.slug}</span>}
                </div>
              ) : (
                <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-red-600">
                  Superuser
                </div>
              )}
            </div>
          )}
        </Link>
      </div>

      {/* Nav */}
      <nav className={cn("flex-1 overflow-y-auto", collapsed ? "px-2 py-4" : "px-3 py-5")} aria-label="Primary">
        {groups.map((g) => (
          <NavGroup
            key={g.id}
            group={g}
            collapsed={collapsed}
            pathname={pathname}
          />
        ))}
      </nav>

      {/* User footer + collapse toggle */}
      <div className="border-t border-border p-3">
        <div className={cn("flex items-center", collapsed ? "flex-col gap-2" : "gap-2.5")}>
          <Avatar name={user.name} src={avatarUrl} size="sm" />
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-ink">{user.name}</div>
              <div className="truncate text-[11px] text-ink-muted">{user.email}</div>
            </div>
          )}
          {!collapsed && (
            <form action="/api/auth/logout" method="POST" className="shrink-0">
              <button
                type="submit"
                aria-label="Sign out"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-inset hover:text-ink"
                title="Sign out"
              >
                <LogOut className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </form>
          )}
        </div>

        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className={cn(
              "mt-2 hidden w-full items-center justify-center rounded-lg border border-border text-ink-subtle transition-colors hover:bg-surface-inset hover:text-ink lg:inline-flex",
              collapsed ? "h-8" : "h-8 gap-1.5 text-[11px]"
            )}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4" strokeWidth={1.75} />
            ) : (
              <>
                <ChevronsLeft className="h-3.5 w-3.5" strokeWidth={2} />
                <span>Collapse</span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── NavGroup ──────────────────────────────────────────────────────

function NavGroup({
  group,
  collapsed,
  pathname,
}: {
  group: Group;
  collapsed: boolean;
  pathname: string;
}) {
  const isCollapsible = group.collapsible === true && !collapsed;
  const [groupCollapsed, toggleGroup] = useGroupCollapsed(
    group.id,
    group.collapsedByDefault === true
  );

  // Auto-expand a collapsed group when an item inside it is active.
  const hasActiveChild = group.items.some((it) => isActive(it.href, pathname));
  const shouldShowItems = !isCollapsible || !groupCollapsed || hasActiveChild;

  return (
    <div className={cn("mb-6", collapsed && "mb-4")}>
      {group.label && !collapsed && (
        isCollapsible ? (
          <button
            type="button"
            onClick={toggleGroup}
            className="mb-2 flex w-full items-center justify-between rounded px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle transition-colors hover:text-ink"
            aria-expanded={!groupCollapsed || hasActiveChild}
          >
            <span>{group.label}</span>
            <ChevronRight
              className={cn(
                "h-3 w-3 transition-transform duration-200",
                (!groupCollapsed || hasActiveChild) && "rotate-90"
              )}
              strokeWidth={2.25}
            />
          </button>
        ) : (
          <div className="mb-2 px-2.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            {group.label}
          </div>
        )
      )}
      {group.label && collapsed && <div className="mb-2 h-px bg-border/70" />}

      {shouldShowItems && (
        <ul className="space-y-[3px]">
          {group.items.map((it) => {
            const active = isActive(it.href, pathname);
            const Icon = it.icon;
            return (
              <li key={it.href + it.label}>
                <Link
                  href={it.href}
                  aria-current={active ? "page" : undefined}
                  title={collapsed ? it.label : undefined}
                  className={cn(
                    "group relative flex items-center rounded-lg text-[13px] font-medium transition-all duration-150 ease-out",
                    collapsed
                      ? "h-9 w-full justify-center"
                      : "gap-2.5 px-2.5 py-[7px]",
                    active
                      ? "bg-gradient-to-r from-brand-subtle to-brand-subtle/40 text-brand-accent"
                      : "text-ink-muted hover:bg-surface-inset/70 hover:text-ink"
                  )}
                >
                  {active && !collapsed && (
                    <span
                      aria-hidden
                      className="absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-brand-accent shadow-[0_0_8px_var(--color-accent-ring)]"
                    />
                  )}
                  <Icon
                    className={cn(
                      "h-[18px] w-[18px] shrink-0 transition-colors",
                      active ? "text-brand-accent" : "text-ink-subtle group-hover:text-ink"
                    )}
                    strokeWidth={1.75}
                  />
                  {!collapsed && (
                    <>
                      <span className="flex-1 truncate">{it.label}</span>
                      {it.soon && (
                        <span className="rounded bg-surface-inset px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-ink-subtle">
                          Soon
                        </span>
                      )}
                      {it.premium && (
                        <span
                          className="rounded bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200/60"
                          title="Pro feature — upgrade required"
                        >
                          Pro
                        </span>
                      )}
                    </>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

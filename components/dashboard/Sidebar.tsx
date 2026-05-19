"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Avatar, Badge } from "@/components/ui/primitives";

type Role = "admin" | "manager" | "staff" | "client";

export type SidebarVariant = "tenant" | "super";

export type SidebarUser = {
  name: string;
  email: string;
  role: Role;
};

export type SidebarTenant = {
  name: string;
  slug: string;
  plan?: string;
  logoUrl?: string | null;
};

type Item = { label: string; href: string; icon: React.ReactNode; soon?: boolean };
type Group = { label?: string; items: Item[] };

const Icon = ({ path }: { path: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden>
    <path d={path} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const I = {
  home:      <Icon path="M3 12l9-9 9 9M5 10v10h14V10" />,
  calendar:  <Icon path="M3 7h18M5 21h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2zM8 3v4M16 3v4" />,
  list:      <Icon path="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  user:      <Icon path="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" />,
  users:     <Icon path="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />,
  briefcase: <Icon path="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2M3 7h18v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7zM3 13h18" />,
  clock:     <Icon path="M12 8v4l3 2M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z" />,
  bar:       <Icon path="M3 3v18h18M7 16V9M12 16V5M17 16v-3" />,
  credit:    <Icon path="M2 7h20v10H2zM2 11h20" />,
  palette:   <Icon path="M12 2a10 10 0 1 0 10 10c0-1.5-3-1.5-3-3s3-1.5 3-3a7 7 0 0 0-7-7zM7.5 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM11.5 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM16.5 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" />,
  link:      <Icon path="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.71 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />,
  shield:    <Icon path="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  bell:      <Icon path="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M13.73 21a2 2 0 0 1-3.46 0" />,
  cube:      <Icon path="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12" />,
  cog:       <Icon path="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />,
  receipt:   <Icon path="M4 2h16v20l-4-2-4 2-4-2-4 2zM8 7h8M8 11h8M8 15h5" />,
  flag:      <Icon path="M4 22V4M4 4l12 4-3 3 3 3-12 4" />,
};

function buildNav(variant: SidebarVariant, role: Role): Group[] {
  if (variant === "super") {
    return [
      {
        label: "Platform",
        items: [
          { label: "Overview",      href: "/admin",                 icon: I.home },
          { label: "Tenants",       href: "/admin/tenants",         icon: I.briefcase },
          { label: "Subscriptions", href: "/admin/subscriptions",   icon: I.credit },
          { label: "Plans",         href: "/admin/plans",           icon: I.cube },
          { label: "Promotions",    href: "/admin/promotions",      icon: I.flag },
          { label: "Announcements", href: "/admin/announcements",   icon: I.bell },
        ],
      },
      {
        label: "Operations",
        items: [
          { label: "Audit logs",    href: "/admin#audit",           icon: I.list },
          { label: "System health", href: "/admin/health",          icon: I.shield },
        ],
      },
    ];
  }

  // tenant variant
  const operations: Item[] = [
    { label: "Dashboard",     href: "/dashboard",                icon: I.home },
    { label: "Calendar",      href: "/dashboard/calendar",       icon: I.calendar },
    { label: "Appointments",  href: "/dashboard/appointments",   icon: I.list },
    { label: "Tasks",         href: "/dashboard/tasks",          icon: I.flag },
    { label: "Notifications", href: "/dashboard/notifications",  icon: I.bell },
  ];

  const records: Item[] = [
    { label: "Customers",   href: "/dashboard/customers",   icon: I.user },
    { label: "Staff",       href: "/dashboard/staff",       icon: I.users },
    { label: "Services",    href: "/dashboard/services",    icon: I.cube },
    { label: "Locations",   href: "/dashboard/locations",   icon: I.flag },
    { label: "Departments", href: "/dashboard/departments", icon: I.briefcase },
  ];

  const time: Item[] = [
    { label: "Working hours", href: "/dashboard/availability",            icon: I.clock },
    { label: "Overrides",     href: "/dashboard/availability/overrides",  icon: I.flag },
    { label: "Calendar sync", href: "/dashboard/settings/calendar",       icon: I.link },
  ];

  const insightAndSettings: Item[] = [
    { label: "Analytics",    href: "/dashboard/analytics",           icon: I.bar },
    { label: "Executive",    href: "/dashboard/analytics/executive", icon: I.bar },
    { label: "Reports",      href: "/dashboard/reports",             icon: I.receipt },
    ...(role === "admin"
      ? [
          { label: "Email log",    href: "/dashboard/emails",               icon: I.bell },
          { label: "Embed widget", href: "/dashboard/settings/embed",       icon: I.cube },
          { label: "Custom domain",href: "/dashboard/settings/domain",      icon: I.link },
          { label: "Billing",      href: "/dashboard/billing",              icon: I.receipt },
          { label: "Branding",     href: "/dashboard/settings/branding",    icon: I.palette },
          { label: "Integrations", href: "/dashboard/settings/integrations", icon: I.link },
          { label: "Communications", href: "/dashboard/settings/communications", icon: I.bell },
          { label: "Feature controls", href: "/dashboard/settings/features", icon: I.flag },
          { label: "Staff routing", href: "/dashboard/settings/routing", icon: I.bar },
          { label: "Booking rules", href: "/dashboard/settings/booking-rules", icon: I.clock },
          { label: "Follow-up automations", href: "/dashboard/settings/automations", icon: I.bell },
          { label: "Waitlists", href: "/dashboard/settings/waitlists", icon: I.users },
          { label: "Recurring bookings", href: "/dashboard/settings/recurring", icon: I.clock },
        ]
      : []),
    // Security is available to ALL signed-in users (read access).
    // Manage actions inside the page are further gated by
    // canManageSecurity.
    { label: "Security", href: "/dashboard/settings/security", icon: I.shield },
  ];

  return [
    { label: "Operate", items: operations },
    { label: "Records", items: records },
    { label: "Time",    items: time },
    { label: "Workspace", items: insightAndSettings },
  ];
}

function isActive(href: string, pathname: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  if (href.includes("?")) return false;
  if (href.includes("#")) return pathname === href.split("#")[0];
  return pathname === href || pathname.startsWith(href + "/");
}

export default function Sidebar({
  user,
  tenant,
  variant = "tenant",
}: {
  user: SidebarUser;
  tenant?: SidebarTenant;
  variant?: SidebarVariant;
}) {
  const pathname = usePathname();
  const groups = buildNav(variant, user.role);

  return (
    <div className="flex h-full flex-col">
      {/* Workspace header */}
      <div className="border-b border-border px-4 py-4">
        <Link href={variant === "super" ? "/admin" : "/dashboard"} className="flex items-center gap-2.5">
          {tenant?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={tenant.logoUrl} alt="" className="h-8 w-8 rounded-md object-contain" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-accent text-sm font-semibold text-white">
              {(tenant?.name ?? "S").slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-ink">{tenant?.name ?? "Scheduling SaaS"}</div>
            {variant === "tenant" ? (
              <div className="flex items-center gap-1.5 text-xs text-ink-muted">
                <span className="truncate">{tenant?.slug ? `/u/${tenant.slug}` : ""}</span>
                {tenant?.plan && (
                  <Badge tone={tenant.plan === "free" ? "neutral" : "blue"} className="capitalize">
                    {tenant.plan}
                  </Badge>
                )}
              </div>
            ) : (
              <div className="text-xs font-medium text-red-600">Superuser console</div>
            )}
          </div>
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Primary">
        {groups.map((g, gi) => (
          <div key={gi} className="mb-4">
            {g.label && (
              <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
                {g.label}
              </div>
            )}
            <ul className="space-y-0.5">
              {g.items.map((it) => {
                const active = isActive(it.href, pathname);
                return (
                  <li key={it.href + it.label}>
                    <Link
                      href={it.href}
                      aria-current={active ? "page" : undefined}
                      className={
                        "group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition " +
                        (active
                          ? "bg-brand-subtle font-medium text-brand-accent"
                          : "text-ink-muted hover:bg-surface-inset hover:text-ink")
                      }
                    >
                      <span className={active ? "text-brand-accent" : "text-ink-subtle group-hover:text-ink"}>
                        {it.icon}
                      </span>
                      <span className="flex-1 truncate">{it.label}</span>
                      {it.soon && (
                        <span className="rounded bg-surface-inset px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-ink-subtle">
                          Soon
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* User footer */}
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-2.5">
          <Avatar name={user.name} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-ink">{user.name}</div>
            <div className="truncate text-xs text-ink-muted">{user.email}</div>
          </div>
          <form action="/api/auth/logout" method="POST" className="shrink-0">
            <button
              type="submit"
              aria-label="Sign out"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-inset hover:text-ink"
              title="Sign out"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4" aria-hidden>
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

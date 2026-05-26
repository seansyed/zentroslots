"use client";

/**
 * SA-9 — Global Command Palette.
 *
 * Cmd+K / Ctrl+K opens a centered modal with three sections:
 *   1) Navigation     — every super-admin page (filtered by query)
 *   2) Tenant search  — async fetch /api/admin/tenants/search?q=
 *   3) Quick actions  — high-value one-clicks (refresh caches, etc.)
 *
 * No external dependency — pure React + fetch + useEffect. Mounts at
 * the Shell level (variant="super" only); listens to keydown on the
 * document. Closes on Escape, on backdrop click, or after navigation.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  BarChart3,
  Brain,
  Briefcase,
  Building2,
  ChevronRight,
  Command,
  CreditCard,
  Database,
  Flag,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

type NavItem = {
  kind: "nav";
  id: string;
  label: string;
  href: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords: string[];
};

type TenantItem = {
  kind: "tenant";
  id: string;
  name: string;
  slug: string;
  plan: string;
  active: boolean;
};

type ActionItem = {
  kind: "action";
  id: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => Promise<void> | void;
};

const NAV_ITEMS: NavItem[] = [
  {
    kind: "nav",
    id: "overview",
    label: "Overview",
    href: "/admin",
    description: "Executive KPI dashboard",
    icon: LayoutDashboard,
    keywords: ["home", "kpi", "metrics", "dashboard", "executive"],
  },
  {
    kind: "nav",
    id: "tenants",
    label: "Tenants",
    href: "/admin/tenants",
    description: "All tenants list",
    icon: Briefcase,
    keywords: ["customers", "accounts", "workspaces"],
  },
  {
    kind: "nav",
    id: "tenant-intel",
    label: "Tenant Intelligence",
    href: "/admin/tenants/intelligence",
    description: "Cross-tenant scoring grid",
    icon: ShieldCheck,
    keywords: ["health", "risk", "score", "ranking"],
  },
  {
    kind: "nav",
    id: "subscriptions",
    label: "Subscriptions",
    href: "/admin/subscriptions",
    description: "Stripe subscriptions",
    icon: CreditCard,
    keywords: ["billing", "plans", "stripe"],
  },
  {
    kind: "nav",
    id: "plans",
    label: "Plans",
    href: "/admin/plans",
    description: "Pricing tiers",
    icon: Database,
    keywords: ["pricing", "tiers"],
  },
  {
    kind: "nav",
    id: "promotions",
    label: "Promotions",
    href: "/admin/promotions",
    description: "Coupons + promo codes",
    icon: Flag,
    keywords: ["coupons", "discounts", "promos"],
  },
  {
    kind: "nav",
    id: "announcements",
    label: "Announcements",
    href: "/admin/announcements",
    description: "Platform-wide banners",
    icon: Megaphone,
    keywords: ["news", "banners", "broadcast"],
  },
  {
    kind: "nav",
    id: "revenue",
    label: "Revenue",
    href: "/admin/revenue",
    description: "ARR, MRR, churn charts",
    icon: BarChart3,
    keywords: ["arr", "mrr", "churn", "revenue"],
  },
  {
    kind: "nav",
    id: "finance",
    label: "Finance",
    href: "/admin/finance",
    description: "Dunning + reconciliation",
    icon: CreditCard,
    keywords: ["dunning", "stripe", "recon", "finance", "money"],
  },
  {
    kind: "nav",
    id: "activity",
    label: "Activity",
    href: "/admin/activity",
    description: "Live activity feed + anomalies",
    icon: Activity,
    keywords: ["feed", "live", "events", "anomalies"],
  },
  {
    kind: "nav",
    id: "security",
    label: "Security",
    href: "/admin/security",
    description: "Audit explorer + IP intel",
    icon: ShieldCheck,
    keywords: ["audit", "ip", "auth", "permissions", "logs"],
  },
  {
    kind: "nav",
    id: "intelligence",
    label: "Operations Intelligence",
    href: "/admin/intelligence",
    description: "Deterministic insights engine",
    icon: Brain,
    keywords: ["insights", "ai", "intelligence", "rules", "recommendations"],
  },
  {
    kind: "nav",
    id: "system-health",
    label: "System health",
    href: "/admin/system-health",
    description: "Workers + integrations health",
    icon: Activity,
    keywords: ["health", "workers", "cron", "integrations", "infra"],
  },
  {
    kind: "nav",
    id: "ops",
    label: "Operator Diagnostics",
    href: "/admin/ops",
    description: "Cron heartbeat + stuck queues + 24h failures",
    icon: Activity,
    keywords: ["ops", "diagnostics", "cron", "heartbeat", "stuck", "failures"],
  },
  {
    kind: "nav",
    id: "diagnostics",
    label: "Admin Diagnostics",
    href: "/admin/diagnostics",
    description: "Schema drift + KPI smoke + snapshot freshness",
    icon: Activity,
    keywords: ["diagnostics", "schema", "drift", "kpi", "smoke", "snapshot"],
  },
];

function tenantMatches(t: TenantItem, q: string): boolean {
  const lower = q.toLowerCase();
  return (
    t.name.toLowerCase().includes(lower) ||
    t.slug.toLowerCase().includes(lower)
  );
}

function navMatches(n: NavItem, q: string): boolean {
  if (!q) return true;
  const lower = q.toLowerCase();
  return (
    n.label.toLowerCase().includes(lower) ||
    n.description.toLowerCase().includes(lower) ||
    n.keywords.some((k) => k.includes(lower))
  );
}

export default function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [tenants, setTenants] = React.useState<TenantItem[]>([]);
  const [loadingTenants, setLoadingTenants] = React.useState(false);
  const [selectedIdx, setSelectedIdx] = React.useState(0);
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const reqIdRef = React.useRef(0);

  // Global Cmd+K / Ctrl+K binding
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Reset state on open
  React.useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      setTenants([]);
      // Focus input on next frame (after the modal renders)
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounced tenant search
  React.useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (term.length < 1) {
      setTenants([]);
      return;
    }
    const myId = ++reqIdRef.current;
    setLoadingTenants(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/tenants/search?q=${encodeURIComponent(term)}`, {
          cache: "no-store",
        });
        if (res.ok && reqIdRef.current === myId) {
          const data = (await res.json()) as { tenants: Array<{ id: string; name: string; slug: string; plan: string; active: boolean }> };
          setTenants(
            data.tenants.map((t) => ({
              kind: "tenant",
              id: t.id,
              name: t.name,
              slug: t.slug,
              plan: t.plan,
              active: t.active,
            })),
          );
        }
      } catch {
        // ignore — palette degrades gracefully
      } finally {
        if (reqIdRef.current === myId) setLoadingTenants(false);
      }
    }, 200);
    return () => window.clearTimeout(t);
  }, [query, open]);

  const actions: ActionItem[] = React.useMemo(
    () => [
      {
        kind: "action",
        id: "refresh-page",
        label: "Refresh this page",
        description: "Force a server refresh of the current admin page",
        icon: RefreshCw,
        run: () => router.refresh(),
      },
    ],
    [router],
  );

  const filteredNav = NAV_ITEMS.filter((n) => navMatches(n, query));
  const filteredActions = query
    ? actions.filter((a) => a.label.toLowerCase().includes(query.toLowerCase()))
    : actions;

  // Flat list for keyboard navigation: [nav..., tenants..., actions...]
  const flat: Array<NavItem | TenantItem | ActionItem> = [
    ...filteredNav,
    ...tenants,
    ...filteredActions,
  ];

  React.useEffect(() => {
    if (selectedIdx >= flat.length) setSelectedIdx(Math.max(0, flat.length - 1));
  }, [flat.length, selectedIdx]);

  function activate(item: NavItem | TenantItem | ActionItem) {
    setOpen(false);
    if (item.kind === "nav") {
      router.push(item.href);
    } else if (item.kind === "tenant") {
      router.push(`/admin/tenants/${item.id}`);
    } else {
      void item.run();
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[selectedIdx];
      if (item) activate(item);
    }
  }

  if (!open) return null;

  let runningIdx = 0;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-[60] flex items-start justify-center bg-slate-900/40 pt-[10vh] backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            onKeyDown={handleKey}
            placeholder="Search pages, tenants, or actions…"
            className="flex-1 bg-transparent text-[14px] text-slate-900 placeholder:text-slate-400 focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="hidden rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 sm:inline-block">
            ESC
          </kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-2">
          {filteredNav.length > 0 ? (
            <SectionLabel icon={Command} title="Navigation" />
          ) : null}
          {filteredNav.map((item) => {
            const idx = runningIdx++;
            return (
              <Row
                key={item.id}
                selected={idx === selectedIdx}
                onMouseEnter={() => setSelectedIdx(idx)}
                onClick={() => activate(item)}
              >
                <item.icon className="h-4 w-4 text-slate-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-slate-900">{item.label}</div>
                  <div className="truncate text-[11px] text-slate-500">{item.description}</div>
                </div>
                <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
              </Row>
            );
          })}

          {query.trim().length >= 1 ? (
            <>
              <SectionLabel icon={Building2} title={`Tenants ${loadingTenants ? "(searching…)" : ""}`} />
              {tenants.length === 0 && !loadingTenants ? (
                <div className="px-4 py-2 text-[12px] text-slate-500">No tenants match "{query}".</div>
              ) : (
                tenants.map((t) => {
                  const idx = runningIdx++;
                  return (
                    <Row
                      key={t.id}
                      selected={idx === selectedIdx}
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onClick={() => activate(t)}
                    >
                      <Building2 className="h-4 w-4 text-slate-500" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium text-slate-900">{t.name}</span>
                          {!t.active ? (
                            <span className="inline-flex items-center rounded-full bg-rose-50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-rose-700">
                              inactive
                            </span>
                          ) : null}
                        </div>
                        <div className="truncate text-[11px] text-slate-500">
                          /u/{t.slug} · {t.plan}
                        </div>
                      </div>
                      <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
                    </Row>
                  );
                })
              )}
            </>
          ) : null}

          {filteredActions.length > 0 ? <SectionLabel icon={Sparkles} title="Quick actions" /> : null}
          {filteredActions.map((a) => {
            const idx = runningIdx++;
            return (
              <Row
                key={a.id}
                selected={idx === selectedIdx}
                onMouseEnter={() => setSelectedIdx(idx)}
                onClick={() => activate(a)}
              >
                <a.icon className="h-4 w-4 text-slate-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-slate-900">{a.label}</div>
                  <div className="truncate text-[11px] text-slate-500">{a.description}</div>
                </div>
              </Row>
            );
          })}

          {flat.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-slate-500">
              Nothing matches "{query}".
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/60 px-4 py-2 text-[11px] text-slate-500">
          <div className="flex items-center gap-2">
            <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px]">↑↓</kbd>
            to navigate
            <kbd className="ml-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px]">↵</kbd>
            to open
          </div>
          <div className="flex items-center gap-2">
            <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
            to toggle
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <div className="mt-1 flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
      <Icon className="h-3 w-3" />
      {title}
    </div>
  );
}

function Row({
  children,
  selected,
  onClick,
  onMouseEnter,
}: {
  children: React.ReactNode;
  selected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors ${
        selected ? "bg-slate-100" : "hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

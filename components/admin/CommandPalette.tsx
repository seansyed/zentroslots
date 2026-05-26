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
  Clock,
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
  {
    kind: "nav",
    id: "simulation",
    label: "Simulation Control",
    href: "/admin/dev/simulation",
    description: "Populate dashboards with synthetic SaaS telemetry",
    icon: Sparkles,
    keywords: ["simulation", "seed", "dev", "demo", "synthetic", "telemetry", "populate"],
  },
];

/**
 * Subsequence fuzzy match — returns a score in [0, 1] or -1 if the
 * query characters can't be matched in order against the haystack.
 * Adjacent-character matches score higher than spread-out matches.
 *
 *   fuzzyScore("revenue", "rev")  → ~0.85
 *   fuzzyScore("revenue", "rvn")  → ~0.55
 *   fuzzyScore("revenue", "xyz")  → -1
 */
function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0.0001;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h.startsWith(n)) return 1; // strong prefix bonus
  let hi = 0;
  let score = 0;
  let lastMatchAt = -1;
  for (let ni = 0; ni < n.length; ni++) {
    let found = -1;
    while (hi < h.length) {
      if (h[hi] === n[ni]) {
        found = hi;
        break;
      }
      hi++;
    }
    if (found === -1) return -1;
    // Adjacency bonus: contiguous matches score higher.
    const gap = lastMatchAt === -1 ? 1 : found - lastMatchAt;
    score += gap === 1 ? 2 : 1 / gap;
    lastMatchAt = found;
    hi = found + 1;
  }
  return score / (h.length + n.length);
}

/** Best fuzzy score across all match-targets for a nav item.
 *  Returns -1 when the query characters don't appear in any. */
function navScore(n: NavItem, q: string): number {
  if (!q) return 0.0001;
  const targets = [n.label, n.description, ...n.keywords];
  let best = -1;
  for (const t of targets) {
    const s = fuzzyScore(t, q);
    if (s > best) best = s;
  }
  return best;
}

function tenantMatches(t: TenantItem, q: string): boolean {
  return (
    fuzzyScore(t.name, q) >= 0 || fuzzyScore(t.slug, q) >= 0
  );
}

// ─── Recents (localStorage) ───────────────────────────────────────

const RECENTS_KEY = "zm:cmdk:recents:v1";
const MAX_RECENTS = 5;

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.slice(0, MAX_RECENTS).filter((x) => typeof x === "string");
  } catch {}
  return [];
}

function pushRecent(id: string) {
  try {
    const existing = loadRecents().filter((x) => x !== id);
    existing.unshift(id);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(existing.slice(0, MAX_RECENTS)));
  } catch {}
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

  // Recents list (only meaningful when query is empty)
  const [recentIds, setRecentIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (open) setRecentIds(loadRecents());
  }, [open]);

  const recentNav: NavItem[] = React.useMemo(() => {
    if (query.trim().length > 0) return [];
    return recentIds
      .map((id) => NAV_ITEMS.find((n) => n.id === id))
      .filter((n): n is NavItem => !!n);
  }, [recentIds, query]);

  // Fuzzy-rank nav items when there's a query; otherwise show all
  // (with recents pulled out into their own section).
  const filteredNav = React.useMemo(() => {
    const q = query.trim();
    if (!q) {
      // No query — show everything not already in Recents.
      const recentSet = new Set(recentIds);
      return NAV_ITEMS.filter((n) => !recentSet.has(n.id));
    }
    return NAV_ITEMS
      .map((n) => ({ n, s: navScore(n, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.n);
  }, [query, recentIds]);

  const filteredActions = query
    ? actions.filter((a) => fuzzyScore(a.label, query) >= 0)
    : actions;

  // Flat list for keyboard navigation: [recents..., nav..., tenants..., actions...]
  const flat: Array<NavItem | TenantItem | ActionItem> = [
    ...recentNav,
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
      pushRecent(item.id);
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
          {recentNav.length > 0 ? (
            <SectionLabel icon={Clock} title="Recent" />
          ) : null}
          {recentNav.map((item) => {
            const idx = runningIdx++;
            return (
              <Row
                key={`recent-${item.id}`}
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

          {filteredNav.length > 0 ? (
            <SectionLabel icon={Command} title={query.trim() ? "Best matches" : "Navigation"} />
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

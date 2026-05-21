"use client";

/**
 * Custom Domains — Command Center client (Phase 15A).
 *
 * Real domain lifecycle UI:
 *   - hero with active / pending / failed KPIs
 *   - add card with hostname validation + examples
 *   - per-domain lifecycle card with DNS instructions, verify button,
 *     remove button, last-checked timestamp, status + ssl badges
 *   - live polling of pending domains every 8s until verified or failed
 *
 * Backend contract:
 *   GET    /api/tenant/domains
 *   POST   /api/tenant/domains
 *   POST   /api/tenant/domains/[id]/verify
 *   DELETE /api/tenant/domains/[id]
 */

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  RotateCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wifi,
  type LucideIcon,
} from "lucide-react";

import { PremiumCard } from "@/components/ui/Card";
import { Button, toast } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

// ─── Types ────────────────────────────────────────────────────────

export type DomainStatus = "pending" | "verified" | "failed";
export type SslStatus = "pending" | "active" | "failed";

export type Domain = {
  id: string;
  host: string;
  normalizedHost: string;
  verificationToken: string;
  status: DomainStatus;
  sslStatus: SslStatus;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Config = { cnameTarget: string; txtPrefix: string };

type VerifyOutcome = {
  status: DomainStatus;
  sslStatus: SslStatus;
  txt: { matched: boolean; observed: string[] };
  cname: { matched: boolean; observed: string[] };
  reason: string | null;
  checkedAt: string;
};

// ─── Root component ───────────────────────────────────────────────

export default function DomainsClient({
  initial,
  config,
  tenantSlug,
}: {
  initial: Domain[];
  config: Config;
  tenantSlug: string;
}) {
  const [rows, setRows] = React.useState<Domain[]>(initial);
  const [hostname, setHostname] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  // Map of domain.id → last DNS verification outcome (UI-only).
  const [outcomes, setOutcomes] = React.useState<Record<string, VerifyOutcome>>({});

  const pendingIds = React.useMemo(
    () => rows.filter((r) => r.status === "pending").map((r) => r.id),
    [rows],
  );

  // Live polling — every 8s, re-verify any pending domains. Quietly stops
  // once everything is verified or failed. UI feedback only — backend
  // does real DNS resolution on each call.
  const pendingKey = pendingIds.join(",");
  React.useEffect(() => {
    if (pendingIds.length === 0) return;
    const id = setInterval(() => {
      pendingIds.forEach((domainId) => {
        verifyDomain(domainId, /* silent */ true);
      });
    }, 8_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  async function addDomain() {
    if (!hostname.trim()) return;
    setAdding(true);
    try {
      const res = await fetch("/api/tenant/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to add domain");
      const newRow: Domain = data.domain;
      setRows((cur) => {
        const idx = cur.findIndex((x) => x.id === newRow.id);
        if (idx >= 0) {
          const next = cur.slice();
          next[idx] = newRow;
          return next;
        }
        return [...cur, newRow];
      });
      setHostname("");
      toast("Domain added — follow the DNS instructions below to verify.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setAdding(false);
    }
  }

  async function verifyDomain(id: string, silent = false) {
    try {
      const res = await fetch(`/api/tenant/domains/${id}/verify`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Verification failed");
      const updated: Domain = data.domain;
      const outcome: VerifyOutcome = data.outcome;
      setRows((cur) => cur.map((r) => (r.id === id ? updated : r)));
      setOutcomes((cur) => ({ ...cur, [id]: outcome }));
      if (!silent) {
        if (outcome.status === "verified") {
          toast(`${updated.host} verified · routing live`, "success");
        } else {
          toast(outcome.reason ?? "Verification didn't pass — check DNS records.", "error");
        }
      }
    } catch (e) {
      if (!silent) toast(e instanceof Error ? e.message : "Failed", "error");
    }
  }

  async function removeDomain(id: string, host: string) {
    if (typeof window !== "undefined" && !window.confirm(`Remove ${host}? Routing will stop immediately.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/tenant/domains/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to remove");
      setRows((cur) => cur.filter((r) => r.id !== id));
      setOutcomes((cur) => {
        const next = { ...cur };
        delete next[id];
        return next;
      });
      toast(`${host} removed`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    }
  }

  const totalActive = rows.filter((r) => r.status === "verified").length;
  const totalPending = rows.filter((r) => r.status === "pending").length;
  const totalFailed = rows.filter((r) => r.status === "failed").length;

  return (
    <div className="mt-3 space-y-4">
      <CommandCenterHero
        active={totalActive}
        pending={totalPending}
        failed={totalFailed}
        tenantSlug={tenantSlug}
      />
      <ArchitectureHelper />
      <SecurityTrustStrip />
      <AddDomainCard
        hostname={hostname}
        setHostname={setHostname}
        adding={adding}
        onAdd={addDomain}
      />
      {rows.length === 0 ? (
        <EmptyDomains />
      ) : (
        <div className="space-y-3">
          {rows.map((d) => (
            <DomainCard
              key={d.id}
              domain={d}
              outcome={outcomes[d.id]}
              cnameTarget={config.cnameTarget}
              txtPrefix={config.txtPrefix}
              onVerify={() => verifyDomain(d.id)}
              onRemove={() => removeDomain(d.id, d.host)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Hero ────────────────────────────────────────────────────────

function CommandCenterHero({
  active,
  pending,
  failed,
  tenantSlug,
}: {
  active: number;
  pending: number;
  failed: number;
  tenantSlug: string;
}) {
  const allHealthy = active > 0 && failed === 0;
  const tone = allHealthy
    ? { dot: "bg-emerald-500", ring: "shadow-[0_0_0_4px_rgba(16,185,129,0.18)]", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200/45", label: "Routing live" }
    : pending > 0
      ? { dot: "bg-amber-500", ring: "shadow-[0_0_0_4px_rgba(245,158,11,0.18)]", chip: "bg-amber-50 text-amber-700 ring-amber-200/45", label: "Awaiting DNS propagation" }
      : { dot: "bg-slate-400", ring: "shadow-[0_0_0_4px_rgba(148,163,184,0.18)]", chip: "bg-surface-inset text-ink-muted ring-border/40", label: "No domains yet" };

  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/55 via-surface to-surface"
    >
      <span aria-hidden className="pointer-events-none absolute -right-28 -top-28 h-72 w-72 rounded-full bg-brand-accent/15 blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute -left-20 -bottom-20 h-56 w-56 rounded-full bg-emerald-200/[0.18] blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent" />

      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-brand-accent">
            <Globe className="h-3 w-3" strokeWidth={2} />
            White-label routing
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Custom Domains
          </h1>
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-ink-muted">
            Serve your booking page from your own hostname (e.g.{" "}
            <code className="rounded bg-surface-inset px-1 py-0.5 font-mono text-[11px] text-ink">book.acme.com</code>).
            Connect a hostname, point DNS, and verify — your edge picks up the routing live.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] ring-1",
              tone.chip,
            )}>
              <span aria-hidden className={cn("inline-block h-1.5 w-1.5 rounded-full", tone.dot, tone.ring)} />
              {tone.label}
            </span>
            <Link
              href={`/u/${tenantSlug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[10px] font-medium text-ink-muted ring-1 ring-border/60 backdrop-blur-sm transition-colors hover:bg-surface hover:text-ink"
            >
              <ExternalLink className="h-2.5 w-2.5" strokeWidth={2} />
              Default URL · /u/{tenantSlug}
            </Link>
          </div>
        </div>
      </div>

      <div className="relative mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <HeroKpi icon={CheckCircle2} label="Active" value={active} sub="Verified · routing" tone="positive" />
        <HeroKpi icon={Loader2} label="Pending" value={pending} sub="Awaiting DNS" tone="amber" />
        <HeroKpi icon={Wifi} label="Failed" value={failed} sub="Re-verify needed" tone={failed > 0 ? "red" : "neutral"} />
        <HeroKpi icon={ShieldCheck} label="Posture" value="TLS" sub="Edge-provisioned" tone="brand" />
      </div>
    </PremiumCard>
  );
}

function HeroKpi({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: number | string;
  sub: string;
  tone: "positive" | "amber" | "red" | "brand" | "neutral";
}) {
  const toneCls =
    tone === "positive"
      ? "from-emerald-50 to-emerald-100/30 text-emerald-700 ring-emerald-200/40"
      : tone === "amber"
        ? "from-amber-50 to-amber-100/30 text-amber-700 ring-amber-200/40"
        : tone === "red"
          ? "from-red-50 to-red-100/30 text-red-700 ring-red-200/40"
          : tone === "brand"
            ? "from-brand-subtle to-surface text-brand-accent ring-brand-accent/15"
            : "from-surface-inset to-surface text-ink-subtle ring-border/40";
  return (
    <div className="rounded-xl border border-border/60 bg-surface/85 p-2.5 ring-1 ring-inset ring-white/40 backdrop-blur-sm">
      <div className="flex items-center gap-1.5">
        <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br ring-1", toneCls)}>
          <Icon className="h-3 w-3" strokeWidth={2} />
        </span>
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">{label}</span>
      </div>
      <div className="mt-1.5 text-[18px] font-semibold leading-none tabular-nums tracking-tight text-ink">{value}</div>
      <div className="mt-1 text-[10px] text-ink-muted">{sub}</div>
    </div>
  );
}

function ArchitectureHelper() {
  return (
    <PremiumCard className="relative overflow-hidden p-3.5">
      <span aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-brand-accent/12 blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
      <div className="relative flex items-start gap-3">
        <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
          <Globe className="h-4 w-4" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-brand-accent">How routing works</div>
          <h2 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">
            Two records · one CNAME for traffic, one TXT for ownership
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
            Add the hostname here, then in your DNS provider add a <strong className="font-semibold text-ink">CNAME</strong>
            {" "}pointing to our edge plus a <strong className="font-semibold text-ink">TXT</strong>{" "}
            verification record. Once both propagate (usually 1–10 minutes), click <em>Verify</em> — the booking page goes live on your hostname immediately. Existing default URLs keep working in parallel.
          </p>
        </div>
      </div>
    </PremiumCard>
  );
}

const TRUST_ITEMS: { icon: LucideIcon; label: string; sub: string }[] = [
  { icon: KeyRound, label: "DNS-verified", sub: "TXT record ownership" },
  { icon: ShieldCheck, label: "Edge TLS", sub: "Automatic provisioning" },
  { icon: Lock, label: "Tenant isolated", sub: "Hostnames globally unique" },
  { icon: Wifi, label: "Real-time routing", sub: "Live within seconds" },
];

function SecurityTrustStrip() {
  return (
    <div className="rounded-2xl border border-border/55 bg-surface/75 p-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.6)] backdrop-blur-sm transition-colors duration-300 hover:border-border/80 sm:p-3">
      <ul className="grid grid-cols-2 gap-x-2 gap-y-2 sm:grid-cols-4 sm:gap-x-1">
        {TRUST_ITEMS.map((t) => {
          const Icon = t.icon;
          return (
            <li
              key={t.label}
              className="group/trust flex items-start gap-2 rounded-lg p-1.5 transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-surface-inset/40"
            >
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-subtle to-surface text-brand-accent ring-1 ring-brand-accent/15 shadow-[0_1px_3px_-1px_rgba(53,157,243,0.18)] transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/trust:shadow-[0_2px_8px_-1px_rgba(53,157,243,0.26)] group-hover/trust:ring-brand-accent/30">
                <Icon className="h-3.5 w-3.5" strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <div className="text-[11.5px] font-semibold leading-[1.2] tracking-tight text-ink">{t.label}</div>
                <div className="mt-0.5 text-[10.5px] leading-[1.25] text-ink-muted">{t.sub}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AddDomainCard({
  hostname,
  setHostname,
  adding,
  onAdd,
}: {
  hostname: string;
  setHostname: (s: string) => void;
  adding: boolean;
  onAdd: () => void;
}) {
  return (
    <PremiumCard className="relative overflow-hidden p-4 sm:p-5">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-brand-subtle text-brand-accent ring-1 ring-brand-accent/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
              <Globe className="h-3.5 w-3.5" strokeWidth={2} />
            </span>
            <div className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-brand-accent">Connect a hostname</div>
          </div>
          <h3 className="mt-1.5 text-[15.5px] font-semibold leading-[1.2] tracking-tight text-ink">Add a custom domain</h3>
          <p className="mt-0.5 text-[11.5px] leading-[1.45] text-ink-muted">Subdomain only — apex domains aren&rsquo;t supported.</p>
        </div>
      </header>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle">
            <Globe className="h-3.5 w-3.5" strokeWidth={1.75} />
          </span>
          <input
            type="text"
            value={hostname}
            onChange={(e) => setHostname(e.target.value.toLowerCase().trim())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hostname && !adding) onAdd();
            }}
            placeholder="book.acme.com"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 font-mono text-[12px] text-ink outline-none transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] placeholder:font-sans placeholder:text-ink-subtle focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/15"
          />
        </div>
        <Button size="sm" onClick={onAdd} disabled={adding || !hostname.trim()}>
          {adding ? (
            <>
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" strokeWidth={2} />
              Adding…
            </>
          ) : (
            <>
              Add domain
              <ArrowRight className="ml-1.5 h-3 w-3" strokeWidth={2.25} />
            </>
          )}
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="text-[10.5px] font-medium text-ink-subtle">Examples:</span>
        {["book.acme.com", "meet.your-firm.com", "schedule.example.io"].map((eg) => (
          <button
            key={eg}
            type="button"
            onClick={() => setHostname(eg)}
            className="inline-flex items-center rounded-full bg-surface-inset px-2 py-0.5 font-mono text-[10.5px] text-ink-muted transition-colors hover:bg-surface-inset/70 hover:text-ink"
          >
            {eg}
          </button>
        ))}
      </div>
    </PremiumCard>
  );
}

function DomainCard({
  domain,
  outcome,
  cnameTarget,
  txtPrefix,
  onVerify,
  onRemove,
}: {
  domain: Domain;
  outcome: VerifyOutcome | undefined;
  cnameTarget: string;
  txtPrefix: string;
  onVerify: () => void | Promise<void>;
  onRemove: () => void | Promise<void>;
}) {
  const [verifying, setVerifying] = React.useState(false);
  const [showInstructions, setShowInstructions] = React.useState(domain.status !== "verified");

  async function handleVerify() {
    setVerifying(true);
    try {
      await onVerify();
    } finally {
      setVerifying(false);
    }
  }

  const isLive = domain.status === "verified";
  const isFailed = domain.status === "failed";

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-surface p-3.5 transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] sm:p-4",
        isLive
          ? "border-border-strong shadow-[0_1px_2px_rgba(15,23,42,0.06),0_2px_6px_-3px_rgba(15,23,42,0.06),inset_0_1px_0_rgba(255,255,255,0.65)] hover:shadow-[0_10px_26px_-14px_rgba(15,23,42,0.18),0_3px_8px_-4px_rgba(15,23,42,0.06),inset_0_1px_0_rgba(255,255,255,0.65)]"
          : isFailed
            ? "border-red-200/70 shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.45)] hover:border-red-300/80"
            : "border-border/70 shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.45)] hover:border-border hover:shadow-[0_6px_16px_-10px_rgba(15,23,42,0.14)]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`https://${domain.host}/`}
              target="_blank"
              rel="noopener noreferrer"
              className="group/host inline-flex items-center gap-1.5 font-mono text-[13.5px] font-semibold tracking-tight text-ink transition-colors hover:text-brand-accent"
            >
              {domain.host}
              <ExternalLink className="h-3 w-3 text-ink-subtle transition-colors group-hover/host:text-brand-accent" strokeWidth={2} />
            </a>
            <DomainStatusChip status={domain.status} />
            <SslStatusChip status={domain.sslStatus} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-subtle">
            <span>Added {formatDate(domain.createdAt)}</span>
            {domain.lastCheckedAt && <span>· Last checked {formatRelative(domain.lastCheckedAt)}</span>}
            {domain.verifiedAt && <span>· Verified {formatDate(domain.verifiedAt)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="secondary" onClick={handleVerify} disabled={verifying}>
            {verifying ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" strokeWidth={2} />
                Verifying…
              </>
            ) : (
              <>
                <RotateCw className="mr-1 h-3 w-3" strokeWidth={2} />
                {isLive ? "Re-check" : "Verify"}
              </>
            )}
          </Button>
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${domain.host}`}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface text-ink-muted transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-px hover:border-red-200 hover:bg-red-50/60 hover:text-red-700 hover:shadow-sm"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {outcome?.reason && !isLive && (
        <div className="mt-3 rounded-lg border border-amber-200/60 bg-amber-50/60 px-2.5 py-1.5 text-[11px] text-amber-800">
          <span className="font-semibold">DNS check:</span> {outcome.reason}
        </div>
      )}

      {isLive && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200/55 bg-emerald-50/45 px-3 py-2 text-[11.5px] text-emerald-800">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.25} />
            Routing live. Customers can book directly from{" "}
            <code className="rounded bg-white/60 px-1.5 py-0.5 font-mono text-[11px] text-emerald-900">https://{domain.host}/</code>
          </span>
        </div>
      )}

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowInstructions((x) => !x)}
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-tight text-ink-muted transition-colors hover:text-ink"
        >
          <ChevronDown
            className={cn("h-3 w-3 transition-transform duration-200", showInstructions ? "rotate-180" : "")}
            strokeWidth={2}
          />
          DNS setup instructions
        </button>

        {showInstructions && (
          <div className="mt-2 space-y-2">
            <DnsRecordRow
              type="CNAME"
              host={domain.normalizedHost}
              value={cnameTarget}
              observed={outcome?.cname.observed ?? []}
              matched={outcome?.cname.matched}
              note="Points incoming traffic to ZentroMeet's edge so we can serve your booking page."
            />
            <DnsRecordRow
              type="TXT"
              host={`${txtPrefix}.${domain.normalizedHost}`}
              value={domain.verificationToken}
              observed={outcome?.txt.observed ?? []}
              matched={outcome?.txt.matched}
              note="Proves you own this hostname. Verification passes as soon as this record propagates."
            />
            <div className="rounded-lg border border-dashed border-border bg-surface-inset/30 px-3 py-2 text-[10.5px] text-ink-muted">
              Most providers propagate in 1–10 minutes. After adding both records in your DNS host, click <strong className="font-semibold text-ink">Verify</strong> above. We poll automatically every 8 seconds while a domain is pending.
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function DnsRecordRow({
  type,
  host,
  value,
  observed,
  matched,
  note,
}: {
  type: "CNAME" | "TXT";
  host: string;
  value: string;
  observed: string[];
  matched: boolean | undefined;
  note: string;
}) {
  const dotTone =
    matched === true
      ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]"
      : matched === false
        ? "bg-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.18)]"
        : "bg-slate-300";

  return (
    <div className="rounded-lg border border-border/65 bg-surface p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-5 items-center rounded-md bg-surface-inset px-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.10em] text-ink ring-1 ring-border/50">
          {type}
        </span>
        <span aria-hidden className={cn("inline-block h-1.5 w-1.5 rounded-full", dotTone)} />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          {matched === true ? "Verified" : matched === false ? "Not detected" : "Awaiting check"}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[80px,1fr]">
        <DnsField label="Name" value={host} />
        <DnsField label="Value" value={value} />
      </div>
      {observed.length > 0 && matched !== true && (
        <div className="mt-1.5 text-[10.5px] text-ink-subtle">
          <span className="font-medium text-ink-muted">Observed:</span>{" "}
          <code className="rounded bg-surface-inset px-1 py-0.5 font-mono text-[10px] text-ink">
            {observed[0]}
            {observed.length > 1 ? ` +${observed.length - 1} more` : ""}
          </code>
        </div>
      )}
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-subtle">{note}</p>
    </div>
  );
}

function DnsField({ label, value }: { label: string; value: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${label} copied`, "success");
    } catch {
      toast("Copy failed — select manually", "error");
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="hidden text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle sm:inline-block">{label}</span>
      <div className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md bg-surface-inset px-2 py-1">
        <code className="truncate font-mono text-[11px] text-ink">{value}</code>
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle transition-colors hover:bg-surface hover:text-ink"
          aria-label={`Copy ${label}`}
        >
          <Copy className="h-2.5 w-2.5" strokeWidth={2.25} />
          Copy
        </button>
      </div>
    </div>
  );
}

function DomainStatusChip({ status }: { status: DomainStatus }) {
  const base = "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ring-1";
  if (status === "verified") {
    return (
      <span className={cn(base, "bg-gradient-to-b from-emerald-50 to-emerald-100/60 text-emerald-800 ring-emerald-300/60 shadow-[0_1px_2px_-1px_rgba(16,185,129,0.22)]")}>
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.24)]" />
        Verified
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className={cn(base, "bg-red-50 text-red-700 ring-red-200/55")}>
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
        DNS mismatch
      </span>
    );
  }
  return (
    <span className={cn(base, "bg-gradient-to-b from-amber-50 to-amber-100/55 text-amber-800 ring-amber-300/55")}>
      <Loader2 className="h-2 w-2 animate-spin" strokeWidth={2.5} />
      Pending DNS
    </span>
  );
}

function SslStatusChip({ status }: { status: SslStatus }) {
  const base = "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ring-1";
  if (status === "active") {
    return (
      <span className={cn(base, "bg-gradient-to-b from-emerald-50 to-emerald-100/45 text-emerald-700 ring-emerald-200/55")}>
        <Lock className="h-2 w-2" strokeWidth={2.5} />
        TLS active
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className={cn(base, "bg-red-50 text-red-700 ring-red-200/55")}>
        <Lock className="h-2 w-2" strokeWidth={2.5} />
        TLS failed
      </span>
    );
  }
  return (
    <span className={cn(base, "bg-gradient-to-b from-blue-50 to-blue-100/45 text-blue-700 ring-blue-200/55")}>
      <Sparkles className="h-2 w-2" strokeWidth={2.5} />
      TLS provisioning
    </span>
  );
}

function EmptyDomains() {
  return (
    <PremiumCard className="relative overflow-hidden p-6 text-center sm:p-8">
      <span aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
      <div className="relative mx-auto mb-3 inline-flex">
        <span aria-hidden className="absolute inset-0 rounded-2xl bg-brand-accent/10 blur-xl" />
        <span className="relative inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-subtle to-surface text-brand-accent ring-1 ring-brand-accent/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
          <Globe className="h-5 w-5" strokeWidth={1.75} />
        </span>
      </div>
      <div className="relative text-[14px] font-semibold tracking-tight text-ink">No custom domains yet</div>
      <p className="relative mx-auto mt-1 max-w-sm text-[11.5px] leading-relaxed text-ink-muted">
        Add a hostname above to start routing your booking page through your own domain. Verification typically takes 1–10 minutes once DNS records are added.
      </p>
      <div className="relative mt-4">
        <button
          type="button"
          onClick={() => {
            document.querySelector<HTMLInputElement>("input[placeholder='book.acme.com']")?.focus();
          }}
          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-accent hover:underline"
        >
          Add your first domain
          <ArrowUpRight className="h-3 w-3" strokeWidth={2.25} />
        </button>
      </div>
    </PremiumCard>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return formatDate(iso);
}

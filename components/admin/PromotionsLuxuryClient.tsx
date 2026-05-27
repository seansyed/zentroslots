"use client";

/**
 * Promotions, Coupons & Growth Campaign Center.
 *
 * Four layers:
 *   1. Executive KPIs — active campaigns, total redemptions, expiring soon,
 *      top campaign, cap utilization
 *   2. Filter / search bar — by status, kind, free-text on code/description
 *   3. Campaign cards — one per promo with rich identity, status pill,
 *      Stripe sync chip, redemption progress ring, expiry urgency, targeting
 *   4. Create / edit modal — uses the existing /api/admin/promotions
 *      route. No new wire-up. Multi-kind form respects validation.
 *
 * Strict invariants:
 *   • Every metric is from a real DB column or derived deterministically.
 *     No fake "MRR influenced" or "conversion lift" %.
 *   • The existing API contract is preserved. We POST the same body
 *     shape the server already accepts — additive fields (status,
 *     stripe_*, target_plans, metadata) are NOT required.
 *   • The kind field accepts the existing 3 values plus the campaign-
 *     wave additions. Server validator (zod) limits writes to known
 *     kinds; older kinds work unchanged.
 */

import * as React from "react";
import { confirmAction } from "@/components/ui/primitives";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Gift,
  Loader2,
  Pause,
  Plus,
  Search,
  Sparkles,
  Tag,
  Trash2,
  TrendingUp,
  X,
  Zap,
} from "lucide-react";

import { AnimatedCounter } from "@/components/ui/AnimatedCounter";
import { PremiumEmptyState } from "@/components/ui/PremiumEmptyState";
import type {
  CampaignKpis,
  EnrichedPromotion,
  PromotionStatus,
} from "@/lib/admin-analytics/promotions-intelligence";

// ─── Helpers ──────────────────────────────────────────────────────

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / (24 * 60 * 60_000));
}

const KIND_META: Record<
  string,
  { label: string; tone: string; icon: React.ComponentType<{ className?: string }> }
> = {
  percent: { label: "% Off", tone: "bg-sky-50 text-sky-700 ring-sky-200", icon: Tag },
  fixed: { label: "$ Off", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200", icon: Tag },
  trial_extension: { label: "Trial+", tone: "bg-violet-50 text-violet-700 ring-violet-200", icon: Clock },
  free_month: { label: "Free Month", tone: "bg-amber-50 text-amber-800 ring-amber-200", icon: Gift },
  seat_expansion: { label: "Bonus Seats", tone: "bg-indigo-50 text-indigo-700 ring-indigo-200", icon: TrendingUp },
  annual_incentive: { label: "Annual", tone: "bg-emerald-50 text-emerald-700 ring-emerald-200", icon: Zap },
  referral: { label: "Referral", tone: "bg-rose-50 text-rose-700 ring-rose-200", icon: Sparkles },
  winback: { label: "Winback", tone: "bg-amber-50 text-amber-800 ring-amber-200", icon: TrendingUp },
  seasonal: { label: "Seasonal", tone: "bg-violet-50 text-violet-700 ring-violet-200", icon: Sparkles },
};

const STATUS_META: Record<PromotionStatus, { label: string; dot: string; ring: string }> = {
  draft: { label: "Draft", dot: "bg-slate-400", ring: "ring-slate-200" },
  scheduled: { label: "Scheduled", dot: "bg-sky-500", ring: "ring-sky-200" },
  active: { label: "Active", dot: "bg-emerald-500", ring: "ring-emerald-200" },
  paused: { label: "Paused", dot: "bg-amber-500", ring: "ring-amber-200" },
  expired: { label: "Expired", dot: "bg-slate-400", ring: "ring-slate-200" },
  archived: { label: "Archived", dot: "bg-slate-300", ring: "ring-slate-200" },
};

// ─── KPI tile ─────────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "neutral" | "growth" | "warning";
}) {
  const ring = tone === "growth" ? "ring-emerald-200" : tone === "warning" ? "ring-amber-200" : "ring-slate-200";
  return (
    <div className={`rounded-xl bg-white p-4 ring-1 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${ring}`}>
      <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div
        className="mt-1 text-[24px] font-semibold leading-none text-slate-900"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </div>
      {hint ? <div className="mt-1 text-[11px] text-slate-500">{hint}</div> : null}
    </div>
  );
}

// ─── Redemption progress ring ─────────────────────────────────────

function ProgressRing({ pct, size = 36 }: { pct: number; size?: number }) {
  const stroke = 3;
  const r = (size - stroke) / 2;
  const C = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, pct)) * C;
  const tone =
    pct >= 0.9 ? "text-rose-500" : pct >= 0.7 ? "text-amber-500" : "text-emerald-500";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="overflow-visible">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="currentColor"
        strokeWidth={stroke}
        fill="none"
        className="text-slate-100"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={`${dash} ${C}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className={tone}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-slate-700 text-[9px] font-semibold"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {Math.round(pct * 100)}%
      </text>
    </svg>
  );
}

// ─── Campaign card ────────────────────────────────────────────────

function StatusPill({ status }: { status: PromotionStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-white px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-700 ring-1 ${meta.ring}`}
    >
      <span className={`inline-flex h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

function StripeChip({ promo }: { promo: EnrichedPromotion }) {
  if (promo.stripeCouponId) {
    return (
      <a
        href={`https://dashboard.stripe.com/coupons/${promo.stripeCouponId}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100"
        title={`Stripe Coupon: ${promo.stripeCouponId}`}
      >
        <CheckCircle2 className="h-2.5 w-2.5" />
        Stripe linked
        <ExternalLink className="h-2.5 w-2.5" />
      </a>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 ring-1 ring-slate-200"
      title="No Stripe coupon linked — promo code is recognized in-app but not at Stripe checkout"
    >
      <AlertTriangle className="h-2.5 w-2.5" />
      Not linked
    </span>
  );
}

function CampaignCard({
  promo,
  onCopy,
  onEdit,
  onArchive,
}: {
  promo: EnrichedPromotion;
  onCopy: () => void;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const KindIcon = (KIND_META[promo.kind]?.icon ?? Tag) as React.ComponentType<{
    className?: string;
  }>;
  const kindMeta = KIND_META[promo.kind] ?? { label: promo.kind, tone: "bg-slate-100 text-slate-700 ring-slate-200" };
  const daysLeft = daysUntil(promo.expiresAt);

  return (
    <article className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(15,23,42,0.08)]">
      {/* Urgency stripe */}
      {promo.expiringSoon ? (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-amber-400 via-amber-500 to-amber-400" />
      ) : null}
      {promo.isExpired ? (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-slate-300" />
      ) : null}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${kindMeta.tone}`}
            >
              <KindIcon className="h-2.5 w-2.5" />
              {kindMeta.label}
            </span>
            <StatusPill status={promo.status} />
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[13px] font-medium text-slate-900">
              {promo.code}
            </code>
            <button
              type="button"
              onClick={onCopy}
              className="text-slate-400 transition-colors hover:text-slate-700"
              title="Copy code"
            >
              <Copy className="h-3 w-3" />
            </button>
          </div>
          {promo.description ? (
            <div className="mt-1.5 text-[12px] leading-relaxed text-slate-600 line-clamp-2">
              {promo.description}
            </div>
          ) : null}
        </div>
        {promo.capUtilization !== null ? <ProgressRing pct={promo.capUtilization} /> : null}
      </div>

      {/* Discount headline */}
      <div className="mt-3 flex items-baseline gap-1">
        <div className="text-[18px] font-semibold tabular-nums text-slate-900">
          {promo.discountLabel}
        </div>
        {promo.targetPlans.length > 0 ? (
          <div className="text-[11px] text-slate-500">
            · on {promo.targetPlans.join(", ")}
          </div>
        ) : promo.appliesToPlan ? (
          <div className="text-[11px] text-slate-500">· on {promo.appliesToPlan}</div>
        ) : (
          <div className="text-[11px] text-slate-500">· all plans</div>
        )}
      </div>

      {/* Stats row */}
      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-[11px]">
        <div>
          <div className="text-slate-500">Redemptions</div>
          <div className="mt-0.5 text-[14px] font-semibold tabular-nums text-slate-900">
            {promo.redemptionCount}
            {promo.maxRedemptions ? (
              <span className="ml-1 text-[11px] font-normal text-slate-400">
                / {promo.maxRedemptions}
              </span>
            ) : null}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Expires</div>
          <div className="mt-0.5 text-[14px] font-semibold tabular-nums text-slate-900">
            {promo.expiresAt ? (
              <span
                className={
                  promo.isExpired
                    ? "text-slate-400"
                    : promo.expiringSoon
                    ? "text-amber-700"
                    : "text-slate-900"
                }
              >
                {fmtDate(promo.expiresAt)}
                {daysLeft !== null && !promo.isExpired ? (
                  <span className="ml-1 text-[10px] font-normal text-slate-500">
                    ({daysLeft}d)
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-slate-400">No expiry</span>
            )}
          </div>
        </div>
      </div>

      {/* Footer — Stripe chip + actions */}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
        <StripeChip promo={promo} />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onArchive}
            className="rounded-md border border-slate-200 bg-white p-1 text-slate-500 hover:bg-rose-50 hover:text-rose-700"
            title="Archive"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    </article>
  );
}

// ─── Create / edit modal ──────────────────────────────────────────

type FormState = {
  code: string;
  description: string;
  kind: string;
  percentOff: string;
  amountOffCents: string;
  trialExtensionDays: string;
  appliesToPlan: string;
  maxRedemptions: string;
  startsAt: string;
  expiresAt: string;
};

const EMPTY_FORM: FormState = {
  code: "",
  description: "",
  kind: "percent",
  percentOff: "",
  amountOffCents: "",
  trialExtensionDays: "",
  appliesToPlan: "",
  maxRedemptions: "",
  startsAt: "",
  expiresAt: "",
};

function CampaignBuilderModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setError(null);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        code: form.code.trim().toUpperCase(),
        description: form.description.trim() || null,
        kind: form.kind,
        active: true,
      };
      if (form.percentOff) body.percentOff = Number(form.percentOff);
      if (form.amountOffCents) body.amountOffCents = Number(form.amountOffCents) * 100;
      if (form.trialExtensionDays) body.trialExtensionDays = Number(form.trialExtensionDays);
      if (form.appliesToPlan) body.appliesToPlan = form.appliesToPlan;
      if (form.maxRedemptions) body.maxRedemptions = Number(form.maxRedemptions);
      if (form.startsAt) body.startsAt = new Date(form.startsAt).toISOString();
      if (form.expiresAt) body.expiresAt = new Date(form.expiresAt).toISOString();

      const res = await fetch("/api/admin/promotions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? `HTTP ${res.status}`);
        return;
      }
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const kindOptions: Array<{ value: string; label: string; hint: string }> = [
    { value: "percent", label: "% off", hint: "Percentage discount on the linked plan" },
    { value: "fixed", label: "$ off", hint: "Fixed-amount discount in cents" },
    { value: "trial_extension", label: "Trial extension", hint: "Add days to the trial window" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 pt-[8vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
              New campaign
            </div>
            <h3 className="mt-0.5 text-base font-semibold text-slate-900">Create promotion</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {/* Kind selector */}
          <div className="mb-3">
            <label className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Campaign type
            </label>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {kindOptions.map((k) => (
                <button
                  key={k.value}
                  type="button"
                  onClick={() => setForm({ ...form, kind: k.value })}
                  className={`rounded-lg border p-2 text-left transition-all ${
                    form.kind === k.value
                      ? "border-sky-300 bg-sky-50/40 shadow-sm"
                      : "border-slate-200 bg-white hover:border-slate-300"
                  }`}
                >
                  <div className="text-[12px] font-medium text-slate-900">{k.label}</div>
                  <div className="mt-0.5 text-[10px] leading-tight text-slate-500">{k.hint}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Code */}
          <Field label="Code">
            <input
              type="text"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="LAUNCH50"
              className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[13px] font-mono uppercase placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
            />
          </Field>

          <Field label="Description">
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="50% off the first month of Pro for product hunt launch"
              className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[13px] placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
            />
          </Field>

          {/* Value based on kind */}
          {form.kind === "percent" ? (
            <Field label="Percent off (1–100)">
              <input
                type="number"
                value={form.percentOff}
                onChange={(e) => setForm({ ...form, percentOff: e.target.value })}
                placeholder="50"
                min={1}
                max={100}
                className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[13px] focus:border-slate-400 focus:outline-none"
              />
            </Field>
          ) : null}
          {form.kind === "fixed" ? (
            <Field label="Amount off (USD)">
              <input
                type="number"
                value={form.amountOffCents}
                onChange={(e) => setForm({ ...form, amountOffCents: e.target.value })}
                placeholder="10"
                min={1}
                step={0.01}
                className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[13px] focus:border-slate-400 focus:outline-none"
              />
            </Field>
          ) : null}
          {form.kind === "trial_extension" ? (
            <Field label="Extra trial days">
              <input
                type="number"
                value={form.trialExtensionDays}
                onChange={(e) => setForm({ ...form, trialExtensionDays: e.target.value })}
                placeholder="14"
                min={1}
                max={365}
                className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[13px] focus:border-slate-400 focus:outline-none"
              />
            </Field>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Applies to plan (slug)">
              <input
                type="text"
                value={form.appliesToPlan}
                onChange={(e) => setForm({ ...form, appliesToPlan: e.target.value })}
                placeholder="pro"
                className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[13px] focus:border-slate-400 focus:outline-none"
              />
            </Field>
            <Field label="Max redemptions">
              <input
                type="number"
                value={form.maxRedemptions}
                onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })}
                placeholder="100"
                min={1}
                className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[13px] focus:border-slate-400 focus:outline-none"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts at">
              <input
                type="datetime-local"
                value={form.startsAt}
                onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[13px] focus:border-slate-400 focus:outline-none"
              />
            </Field>
            <Field label="Expires at">
              <input
                type="datetime-local"
                value={form.expiresAt}
                onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
                className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[13px] focus:border-slate-400 focus:outline-none"
              />
            </Field>
          </div>

          {error ? (
            <div className="mt-3 rounded-md border border-rose-200 bg-rose-50/60 px-3 py-2 text-[12px] text-rose-800">
              {error}
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-between border-t border-slate-200 bg-slate-50/60 px-5 py-3">
          <div className="text-[11px] text-slate-500">
            Stripe linking is set via the row editor after creation.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !form.code.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              Create campaign
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// ─── Top-level client ─────────────────────────────────────────────

export default function PromotionsLuxuryClient({
  initial,
  kpis,
}: {
  initial: EnrichedPromotion[];
  kpis: CampaignKpis | null;
}) {
  const [promos, setPromos] = React.useState<EnrichedPromotion[]>(initial);
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<PromotionStatus | "all">("all");
  const [kindFilter, setKindFilter] = React.useState<string>("all");
  const [creating, setCreating] = React.useState(false);

  async function refresh() {
    try {
      const res = await fetch("/api/admin/promotions", { cache: "no-store" });
      if (!res.ok) return;
      // The existing GET returns raw rows. We don't enrich client-side
      // (sparkline + derived flags would re-fetch). Simplest: full page
      // reload via router.refresh through the parent; for now we
      // reload the page.
      window.location.reload();
    } catch {}
  }

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return promos.filter((p) => {
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (kindFilter !== "all" && p.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        p.code.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [promos, query, statusFilter, kindFilter]);

  return (
    <div className="space-y-6">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 -mx-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-slate-500" />
          <div>
            <div className="text-sm font-medium text-slate-900">Growth Campaigns</div>
            <div className="text-[11px] text-slate-500">
              {kpis ? `${kpis.activeCampaigns} active · ${kpis.totalRedemptions} redemptions all time` : "Loading…"}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition-all hover:-translate-y-px hover:bg-slate-800 hover:shadow-md"
        >
          <Plus className="h-3 w-3" />
          New campaign
        </button>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile
          label="Active campaigns"
          value={<AnimatedCounter value={kpis?.activeCampaigns ?? 0} />}
          hint="status=active · not expired · under cap"
          tone="growth"
        />
        <KpiTile
          label="Total redemptions"
          value={<AnimatedCounter value={kpis?.totalRedemptions ?? 0} />}
          hint={kpis ? `${kpis.redemptions30d} in last 30d (campaigns created 30d ago)` : "—"}
        />
        <KpiTile
          label="Expiring soon"
          value={<AnimatedCounter value={kpis?.expiringSoon ?? 0} />}
          hint="within 7 days"
          tone={kpis && kpis.expiringSoon > 0 ? "warning" : "neutral"}
        />
        <KpiTile
          label="Cap utilization"
          value={
            kpis?.capUtilizationPct === null || kpis?.capUtilizationPct === undefined
              ? "—"
              : `${kpis.capUtilizationPct}%`
          }
          hint={kpis?.capUtilizationPct === null ? "no capped promos" : "across all capped promos"}
        />
      </div>

      {/* Top campaign callout */}
      {kpis?.topCampaign ? (
        <div className="rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50/40 to-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100">
                <TrendingUp className="h-4 w-4 text-emerald-700" />
              </div>
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-emerald-700">
                  Highest performer
                </div>
                <div className="text-sm font-medium text-slate-900">
                  <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[12px]">
                    {kpis.topCampaign.code}
                  </code>
                  {kpis.topCampaign.description ? (
                    <span className="ml-2 text-slate-600">{kpis.topCampaign.description}</span>
                  ) : null}
                </div>
              </div>
            </div>
            <div
              className="text-[24px] font-semibold leading-none text-emerald-700"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {kpis.topCampaign.redemptionCount}
              <span className="ml-1 text-[11px] font-normal text-emerald-600">redemptions</span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search code or description…"
            className="w-56 rounded-md border border-slate-200 py-1.5 pl-7 pr-3 text-[13px] focus:border-slate-400 focus:outline-none"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as PromotionStatus | "all")}
          className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px]"
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="scheduled">Scheduled</option>
          <option value="paused">Paused</option>
          <option value="expired">Expired</option>
          <option value="archived">Archived</option>
          <option value="draft">Draft</option>
        </select>
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px]"
        >
          <option value="all">All types</option>
          <option value="percent">% off</option>
          <option value="fixed">$ off</option>
          <option value="trial_extension">Trial extension</option>
          <option value="free_month">Free month</option>
          <option value="seat_expansion">Bonus seats</option>
          <option value="annual_incentive">Annual incentive</option>
          <option value="referral">Referral</option>
          <option value="winback">Winback</option>
          <option value="seasonal">Seasonal</option>
        </select>
        <div className="ml-auto text-[11px] text-slate-500">
          {filtered.length} of {promos.length}
        </div>
      </div>

      {/* Campaign grid */}
      {filtered.length === 0 ? (
        promos.length === 0 ? (
          <PremiumEmptyState
            icon={<Sparkles />}
            title="No campaigns yet"
            description="Create your first promo to drive activation, trial extensions, winback, or referral growth. Every campaign is a real promo code that the checkout flow can apply."
            cta={{ label: "Create campaign", onClick: () => setCreating(true) }}
            tone="info"
          />
        ) : (
          <PremiumEmptyState
            icon={<Search />}
            title="No campaigns match your filters"
            description="Try clearing the status or type filter, or search for a different code."
            tone="neutral"
          />
        )
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p) => (
            <CampaignCard
              key={p.id}
              promo={p}
              onCopy={() => navigator.clipboard.writeText(p.code).catch(() => {})}
              onEdit={() => {
                // Existing single-row editor lives at /admin/promotions/[id]
                window.location.href = `/admin/promotions/${p.id}`;
              }}
              onArchive={() => {
                void confirmAction({
                  title: `Archive promo "${p.code}"?`,
                  body: "The code stops working immediately. Redemption history is kept for audit.",
                  variant: "warning",
                  confirmLabel: "Archive promo",
                }).then((ok: boolean) => {
                  if (!ok) return;
                  void fetch(`/api/admin/promotions/${p.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ active: false }),
                  }).then(() => refresh());
                });
              }}
            />
          ))}
        </div>
      )}

      <CampaignBuilderModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={refresh}
      />
    </div>
  );
}

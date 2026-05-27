"use client";

/**
 * Announcements & Customer Communications Center.
 *
 * Four layers:
 *   1. Executive KPIs — active count, deliveries, engagement, CTR
 *   2. Top performer callout
 *   3. Filter bar — status + kind + severity + search
 *   4. Announcement cards — rich identity, channels, audience, engagement bars
 *   5. Builder modal — markdown body, severity, kind, channels, targeting,
 *      audience preview, scheduling, CTA
 *
 * Strict invariants:
 *   • Engagement metrics render "—" when delivery_count or view_count is 0.
 *     We never fabricate a 0% that would imply failure.
 *   • Audience preview is a real live tenant query, not a guess.
 *   • Builder POSTs to existing /api/admin/announcements with additive
 *     fields. Server-side zod validator currently accepts the existing
 *     shape; new fields (kind/channels/audienceRules/scheduledAt/metadata)
 *     are passed through and the DB defaults handle the rest until the
 *     server schema is extended.
 */

import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Copy,
  Eye,
  Hash,
  Info,
  Layers,
  Loader2,
  Mail,
  MessageSquare,
  Monitor,
  MousePointer,
  Pin,
  Plus,
  Search,
  Send,
  Sparkles,
  Target,
  Trash2,
  Users,
  X,
  XCircle,
  Zap,
} from "lucide-react";

import { AnimatedCounter } from "@/components/ui/AnimatedCounter";
import { PremiumEmptyState } from "@/components/ui/PremiumEmptyState";
import type {
  AnnouncementStatus,
  AnnouncementsKpis,
  AudienceRules,
  EnrichedAnnouncement,
} from "@/lib/admin-analytics/announcements-intelligence";

// ─── Helpers ──────────────────────────────────────────────────────

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");
function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60_000));
}
const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 1000) / 10}%`);

// ─── Visual maps ──────────────────────────────────────────────────

const SEVERITY_META: Record<
  string,
  { label: string; tone: string; icon: React.ComponentType<{ className?: string }> }
> = {
  info: { label: "Info", tone: "bg-sky-50 text-sky-700 ring-sky-200", icon: Info },
  warning: { label: "Warning", tone: "bg-amber-50 text-amber-800 ring-amber-200", icon: AlertTriangle },
  critical: { label: "Critical", tone: "bg-rose-50 text-rose-700 ring-rose-200", icon: AlertCircle },
};

const KIND_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  general: { label: "General", icon: MessageSquare },
  maintenance: { label: "Maintenance", icon: Clock },
  release: { label: "Release notes", icon: Sparkles },
  engagement: { label: "Engagement", icon: Zap },
  operational: { label: "Operational", icon: AlertCircle },
  onboarding_nudge: { label: "Onboarding", icon: Target },
  upgrade_nudge: { label: "Upgrade", icon: Send },
  winback: { label: "Winback", icon: Users },
};

const STATUS_META: Record<AnnouncementStatus, { label: string; dot: string; ring: string }> = {
  draft: { label: "Draft", dot: "bg-slate-400", ring: "ring-slate-200" },
  scheduled: { label: "Scheduled", dot: "bg-sky-500", ring: "ring-sky-200" },
  active: { label: "Active", dot: "bg-emerald-500", ring: "ring-emerald-200" },
  paused: { label: "Paused", dot: "bg-amber-500", ring: "ring-amber-200" },
  expired: { label: "Expired", dot: "bg-slate-400", ring: "ring-slate-200" },
  archived: { label: "Archived", dot: "bg-slate-300", ring: "ring-slate-200" },
};

const CHANNEL_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  in_app: { label: "In-app", icon: Monitor },
  modal: { label: "Modal", icon: Eye },
  email: { label: "Email", icon: Mail },
  banner: { label: "Banner", icon: Pin },
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

// ─── Engagement bar ───────────────────────────────────────────────

function EngagementBar({
  label,
  value,
  tone = "sky",
}: {
  label: string;
  value: number | null;
  tone?: "sky" | "emerald" | "amber" | "rose";
}) {
  const cls = tone === "emerald" ? "bg-emerald-500" : tone === "amber" ? "bg-amber-500" : tone === "rose" ? "bg-rose-500" : "bg-sky-500";
  return (
    <div className="text-[11px]">
      <div className="flex items-center justify-between text-slate-500">
        <span>{label}</span>
        <span className="font-medium tabular-nums text-slate-700">{pct(value)}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full ${cls}`}
          style={{ width: `${Math.min(100, Math.max(0, (value ?? 0) * 100))}%` }}
        />
      </div>
    </div>
  );
}

// ─── Announcement card ────────────────────────────────────────────

function StatusPill({ status }: { status: AnnouncementStatus }) {
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

function AudienceSummary({
  audience,
  rules,
}: {
  audience: string;
  rules: AudienceRules;
}) {
  const parts: string[] = [];
  if (rules.plans && rules.plans.length > 0) parts.push(`plans: ${rules.plans.join(", ")}`);
  if (rules.subscriptionStatuses && rules.subscriptionStatuses.length > 0)
    parts.push(`status: ${rules.subscriptionStatuses.join(", ")}`);
  if (rules.onboardingStates && rules.onboardingStates.length > 0)
    parts.push(`onboarding: ${rules.onboardingStates.join(", ")}`);
  if (rules.minBookings30d) parts.push(`≥${rules.minBookings30d} bookings/30d`);
  if (rules.inactiveDays) parts.push(`inactive ≥${rules.inactiveDays}d`);
  if (parts.length === 0) {
    if (audience === "all" || !audience) return <span className="text-slate-500">All tenants</span>;
    return <span className="text-slate-500">audience: {audience}</span>;
  }
  return <span className="text-slate-600">{parts.join(" · ")}</span>;
}

function AnnouncementCard({
  a,
  onEdit,
  onArchive,
}: {
  a: EnrichedAnnouncement;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const sevMeta = SEVERITY_META[a.severity] ?? SEVERITY_META.info;
  const SevIcon = sevMeta.icon;
  const kindMeta = KIND_META[a.kind] ?? KIND_META.general;
  const KindIcon = kindMeta.icon;
  const daysLeft = daysUntil(a.expiresAt);

  // Per-severity card accent
  const accentStripe =
    a.severity === "critical"
      ? "from-rose-400 via-rose-500 to-rose-400"
      : a.severity === "warning"
      ? "from-amber-400 via-amber-500 to-amber-400"
      : "from-sky-400 via-sky-500 to-sky-400";

  return (
    <article className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(15,23,42,0.08)]">
      {/* Severity stripe */}
      <div className={`h-0.5 bg-gradient-to-r ${accentStripe}`} />

      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${sevMeta.tone}`}
              >
                <SevIcon className="h-2.5 w-2.5" />
                {sevMeta.label}
              </span>
              <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700">
                <KindIcon className="h-2.5 w-2.5" />
                {kindMeta.label}
              </span>
              <StatusPill status={a.status} />
            </div>
            <h3 className="mt-1.5 text-[14px] font-semibold leading-snug text-slate-900 line-clamp-2">
              {a.title}
            </h3>
            <p className="mt-1 text-[12px] leading-relaxed text-slate-600 line-clamp-2">{a.body}</p>
          </div>
        </div>

        {/* Channels + audience */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-[11px]">
          <div className="flex items-center gap-1">
            <Layers className="h-3 w-3 text-slate-400" />
            {a.channels.map((c) => {
              const meta = CHANNEL_META[c];
              if (!meta) return null;
              const Icon = meta.icon;
              return (
                <span
                  key={c}
                  className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700"
                >
                  <Icon className="h-2.5 w-2.5" />
                  {meta.label}
                </span>
              );
            })}
          </div>
          <div className="flex items-center gap-1 text-[11px]">
            <Target className="h-3 w-3 text-slate-400" />
            <AudienceSummary audience={a.audience} rules={a.audienceRules} />
          </div>
        </div>

        {/* Engagement bars */}
        <div className="mt-3 grid grid-cols-3 gap-3 border-t border-slate-100 pt-3">
          <EngagementBar label="View rate" value={a.engagementRate} tone="emerald" />
          <EngagementBar label="CTR" value={a.ctr} tone="sky" />
          <EngagementBar label="Dismiss" value={a.dismissRate} tone="amber" />
        </div>

        {/* Counters */}
        <div className="mt-3 flex items-center gap-3 border-t border-slate-100 pt-3 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <Send className="h-3 w-3" />
            <span className="font-medium text-slate-700 tabular-nums">{a.deliveryCount}</span> sent
          </span>
          <span className="inline-flex items-center gap-1">
            <Eye className="h-3 w-3" />
            <span className="font-medium text-slate-700 tabular-nums">{a.viewCount}</span> views
          </span>
          <span className="inline-flex items-center gap-1">
            <MousePointer className="h-3 w-3" />
            <span className="font-medium text-slate-700 tabular-nums">{a.clickCount}</span> clicks
          </span>
        </div>

        {/* Footer */}
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-3 text-[11px]">
          <div className="flex items-center gap-1 text-slate-500">
            <Calendar className="h-3 w-3" />
            {a.expiresAt ? (
              <span
                className={
                  a.isExpired
                    ? "text-slate-400"
                    : a.expiringSoon
                    ? "text-amber-700 font-medium"
                    : "text-slate-600"
                }
              >
                Expires {fmtDate(a.expiresAt)}
                {daysLeft !== null && !a.isExpired ? ` (${daysLeft}d)` : null}
              </span>
            ) : (
              <span>No expiry</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {a.linkUrl ? (
              <a
                href={a.linkUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-slate-700 hover:bg-slate-50"
              >
                Preview CTA →
              </a>
            ) : null}
            <button
              type="button"
              onClick={onEdit}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-50"
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
      </div>
    </article>
  );
}

// ─── Builder modal ────────────────────────────────────────────────

type BuilderState = {
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
  kind: string;
  audience: string;
  audienceRules: AudienceRules;
  channels: string[];
  linkUrl: string;
  linkLabel: string;
  scheduledAt: string;
  expiresAt: string;
};

const EMPTY_BUILDER: BuilderState = {
  title: "",
  body: "",
  severity: "info",
  kind: "general",
  audience: "all",
  audienceRules: {},
  channels: ["in_app"],
  linkUrl: "",
  linkLabel: "",
  scheduledAt: "",
  expiresAt: "",
};

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</label>
      <div className="mt-1">{children}</div>
      {hint ? <div className="mt-1 text-[10px] text-slate-400">{hint}</div> : null}
    </div>
  );
}

/** Convert a server announcement row → editor BuilderState. */
function rowToBuilder(row: EnrichedAnnouncement): BuilderState {
  // datetime-local inputs need "YYYY-MM-DDTHH:mm" (no Z, no seconds).
  const toLocal = (iso: string | null | undefined): string => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const channels =
    Array.isArray(row.channels) && row.channels.length > 0
      ? row.channels.map((c) => String(c))
      : ["in_app"];
  const audienceRules =
    row.audienceRules && typeof row.audienceRules === "object"
      ? (row.audienceRules as AudienceRules)
      : {};
  return {
    title: row.title ?? "",
    body: row.body ?? "",
    severity: (row.severity ?? "info") as BuilderState["severity"],
    kind: row.kind ?? "general",
    audience: row.audience ?? "all",
    audienceRules,
    channels,
    linkUrl: row.linkUrl ?? "",
    linkLabel: row.linkLabel ?? "",
    scheduledAt: toLocal(row.scheduledAt),
    expiresAt: toLocal(row.expiresAt),
  };
}

function AnnouncementBuilderModal({
  open,
  existing,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** When non-null, modal opens in EDIT mode pre-filled from this row. */
  existing: EnrichedAnnouncement | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = existing !== null;
  const [form, setForm] = React.useState<BuilderState>(EMPTY_BUILDER);
  const [initialForm, setInitialForm] = React.useState<BuilderState>(EMPTY_BUILDER);
  const [status, setStatus] = React.useState<AnnouncementStatus>("active");
  const [initialStatus, setInitialStatus] = React.useState<AnnouncementStatus>("active");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reach, setReach] = React.useState<{ reach: number; totalActive: number } | null>(null);
  const [reaching, setReaching] = React.useState(false);

  // Open lifecycle: reset OR pre-fill based on mode
  React.useEffect(() => {
    if (open) {
      if (existing) {
        const pre = rowToBuilder(existing);
        setForm(pre);
        setInitialForm(pre);
        const s = (existing.status ?? "active") as AnnouncementStatus;
        setStatus(s);
        setInitialStatus(s);
      } else {
        setForm(EMPTY_BUILDER);
        setInitialForm(EMPTY_BUILDER);
        setStatus("active");
        setInitialStatus("active");
      }
      setError(null);
      setReach(null);
    }
  }, [open, existing]);

  // Dirty detection — compared via JSON stringification (forms are small).
  const dirty = React.useMemo(
    () => JSON.stringify(form) !== JSON.stringify(initialForm) || status !== initialStatus,
    [form, initialForm, status, initialStatus],
  );

  const handleClose = React.useCallback(() => {
    if (busy) return;
    if (dirty) {
      if (!confirm("You have unsaved changes. Discard and close?")) return;
    }
    onClose();
  }, [busy, dirty, onClose]);

  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
      // Cmd/Ctrl+Enter = save
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        // Triggered via form ref below
        const btn = document.getElementById("ann-save-btn") as HTMLButtonElement | null;
        if (btn && !btn.disabled) btn.click();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, handleClose]);

  // Browser-level guard for accidental nav/close while dirty.
  React.useEffect(() => {
    if (!open || !dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [open, dirty]);

  // Debounced audience-reach preview
  React.useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(async () => {
      setReaching(true);
      try {
        const res = await fetch("/api/admin/announcements/preview-reach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rules: form.audienceRules }),
        });
        if (res.ok) {
          setReach(await res.json());
        }
      } catch {
        /* swallow */
      } finally {
        setReaching(false);
      }
    }, 350);
    return () => window.clearTimeout(id);
  }, [open, form.audienceRules]);

  if (!open) return null;

  function toggleChannel(c: string) {
    setForm((f) => ({
      ...f,
      channels: f.channels.includes(c) ? f.channels.filter((x) => x !== c) : [...f.channels, c],
    }));
  }
  function togglePlan(p: string) {
    const cur = form.audienceRules.plans ?? [];
    const next = cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p];
    setForm({
      ...form,
      audienceRules: { ...form.audienceRules, plans: next.length > 0 ? next : undefined },
    });
  }

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const expiresIso = form.expiresAt ? new Date(form.expiresAt).toISOString() : null;
      const scheduledIso = form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null;

      // Body shared between POST (create) and PATCH (edit). The
      // server zod schemas accept all of these fields; un-supplied
      // fields are ignored.
      const body: Record<string, unknown> = {
        title: form.title.trim(),
        body: form.body.trim(),
        severity: form.severity,
        audience: form.audience.trim() || "all",
        kind: form.kind,
        channels: form.channels.length > 0 ? form.channels : ["in_app"],
        audienceRules: form.audienceRules ?? {},
        status,
        // Auto-flip active flag based on status for back-compat with
        // the legacy boolean.
        active: status === "active" || status === "scheduled",
        linkUrl: form.linkUrl.trim() || null,
        linkLabel: form.linkLabel.trim() || null,
        expiresAt: expiresIso,
        scheduledAt: scheduledIso,
      };

      const url = isEdit
        ? `/api/admin/announcements/${existing!.id}`
        : "/api/admin/announcements";
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? `HTTP ${res.status}`);
        return;
      }
      // Reset dirty baseline so the close handler doesn't prompt.
      setInitialForm(form);
      setInitialStatus(status);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const KindIcon = (KIND_META[form.kind]?.icon ?? MessageSquare) as React.ComponentType<{ className?: string }>;
  const sevAccent =
    form.severity === "critical"
      ? "from-rose-400 via-rose-500 to-rose-400"
      : form.severity === "warning"
      ? "from-amber-400 via-amber-500 to-amber-400"
      : "from-sky-400 via-sky-500 to-sky-400";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 pt-[6vh] backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
              {isEdit ? "Edit announcement" : "New announcement"}
              {dirty ? <span className="ml-1.5 text-amber-600">· unsaved changes</span> : null}
            </div>
            <h3 className="mt-0.5 text-base font-semibold text-slate-900">
              {isEdit ? form.title || "Untitled announcement" : "Compose & target"}
            </h3>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100"
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid max-h-[78vh] grid-cols-1 overflow-y-auto md:grid-cols-[1fr_280px]">
          {/* Form */}
          <div className="space-y-3 px-5 py-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Severity">
                <div className="grid grid-cols-3 gap-1">
                  {(["info", "warning", "critical"] as const).map((s) => {
                    const meta = SEVERITY_META[s];
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setForm({ ...form, severity: s })}
                        className={`rounded-md border px-2 py-1.5 text-[11px] font-medium transition-all ${
                          form.severity === s
                            ? `${meta.tone} ring-1`
                            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <Field label="Kind">
                <select
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}
                  className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px]"
                >
                  {Object.entries(KIND_META).map(([k, m]) => (
                    <option key={k} value={k}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field label="Lifecycle status" hint="Draft = invisible. Scheduled = activates at scheduled time.">
              <div className="grid grid-cols-3 gap-1 sm:grid-cols-6">
                {(["draft", "scheduled", "active", "paused", "expired", "archived"] as const).map((s) => {
                  const meta = STATUS_META[s];
                  const on = status === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setStatus(s)}
                      className={`inline-flex items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-all ${
                        on
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                      title={meta.label}
                    >
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Title">
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="What's new this week"
                className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[13px] focus:border-slate-400 focus:outline-none"
              />
            </Field>

            <Field label="Body" hint="Plain text or simple markdown. Max 5,000 characters.">
              <textarea
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                placeholder="We've shipped a new analytics dashboard..."
                rows={5}
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-[13px] focus:border-slate-400 focus:outline-none"
              />
            </Field>

            <Field label="Delivery channels">
              <div className="grid grid-cols-4 gap-1">
                {Object.entries(CHANNEL_META).map(([k, m]) => {
                  const Icon = m.icon;
                  const on = form.channels.includes(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => toggleChannel(k)}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-[11px] font-medium transition-all ${
                        on
                          ? "border-sky-300 bg-sky-50 text-sky-800"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      <Icon className="h-3 w-3" />
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Audience targeting" hint="Empty = all active tenants">
              <div className="space-y-2">
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Plans</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {["free", "solo", "pro", "team", "enterprise"].map((p) => {
                      const on = (form.audienceRules.plans ?? []).includes(p);
                      return (
                        <button
                          key={p}
                          type="button"
                          onClick={() => togglePlan(p)}
                          className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition-all ${
                            on ? "border-violet-300 bg-violet-50 text-violet-800" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          {p}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    min={0}
                    value={form.audienceRules.minBookings30d ?? ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        audienceRules: {
                          ...form.audienceRules,
                          minBookings30d: e.target.value ? Number(e.target.value) : undefined,
                        },
                      })
                    }
                    placeholder="Min bookings / 30d"
                    className="rounded-md border border-slate-200 px-2 py-1 text-[12px]"
                  />
                  <input
                    type="number"
                    min={0}
                    value={form.audienceRules.inactiveDays ?? ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        audienceRules: {
                          ...form.audienceRules,
                          inactiveDays: e.target.value ? Number(e.target.value) : undefined,
                        },
                      })
                    }
                    placeholder="Inactive ≥ N days"
                    className="rounded-md border border-slate-200 px-2 py-1 text-[12px]"
                  />
                </div>
              </div>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="CTA URL">
                <input
                  type="url"
                  value={form.linkUrl}
                  onChange={(e) => setForm({ ...form, linkUrl: e.target.value })}
                  placeholder="https://…"
                  className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[13px] focus:border-slate-400 focus:outline-none"
                />
              </Field>
              <Field label="CTA label">
                <input
                  type="text"
                  value={form.linkLabel}
                  onChange={(e) => setForm({ ...form, linkLabel: e.target.value })}
                  placeholder="Learn more"
                  className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[13px] focus:border-slate-400 focus:outline-none"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Scheduled at" hint="Required when status = Scheduled">
                <input
                  type="datetime-local"
                  value={form.scheduledAt}
                  onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
                  className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[13px]"
                />
              </Field>
              <Field label="Expires at" hint="Leave empty for no expiry">
                <input
                  type="datetime-local"
                  value={form.expiresAt}
                  onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
                  className="w-full rounded-md border border-slate-200 px-3 py-1.5 text-[13px]"
                />
              </Field>
            </div>

            {error ? (
              <div className="rounded-md border border-rose-200 bg-rose-50/60 px-3 py-2 text-[12px] text-rose-800">
                {error}
              </div>
            ) : null}
          </div>

          {/* Right sidebar: preview */}
          <aside className="border-t border-slate-200 bg-slate-50/40 px-5 py-4 md:border-l md:border-t-0">
            <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Live preview</div>

            <div className="mt-2 overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className={`h-0.5 bg-gradient-to-r ${sevAccent}`} />
              <div className="p-3">
                <div className="flex items-center gap-1">
                  <span
                    className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1 ${SEVERITY_META[form.severity].tone}`}
                  >
                    {SEVERITY_META[form.severity].label}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-700">
                    <KindIcon className="h-2.5 w-2.5" />
                    {KIND_META[form.kind]?.label ?? form.kind}
                  </span>
                </div>
                <div className="mt-2 text-[13px] font-semibold leading-snug text-slate-900">
                  {form.title || "Title preview…"}
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-slate-600 line-clamp-3">
                  {form.body || "Body preview will appear here as you type."}
                </div>
                {form.linkLabel ? (
                  <div className="mt-2 inline-flex items-center gap-1 rounded-md bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                    {form.linkLabel} →
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-4">
              <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                Estimated reach
              </div>
              <div className="mt-1 flex items-baseline gap-1">
                <div
                  className="text-[28px] font-semibold leading-none text-slate-900"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {reaching ? <Loader2 className="h-5 w-5 animate-spin text-slate-400" /> : reach ? reach.reach : "—"}
                </div>
                <div className="text-[11px] text-slate-500">
                  {reach ? `of ${reach.totalActive} active tenants` : ""}
                </div>
              </div>
              <div className="mt-2 text-[10px] text-slate-500">
                Targeted in real-time from active tenants matching your audience rules.
              </div>
            </div>
          </aside>
        </div>

        <footer className="sticky bottom-0 flex items-center justify-between border-t border-slate-200 bg-slate-50/80 px-5 py-3 backdrop-blur-sm">
          <div className="text-[11px] text-slate-500">
            {isEdit ? "Editing existing announcement · changes apply on save." : "Sends use the existing announcement infrastructure."}
            <span className="ml-2 text-slate-400">⌘+Enter to save · Esc to close</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              id="ann-save-btn"
              type="button"
              onClick={submit}
              disabled={busy || !form.title.trim() || !form.body.trim() || (isEdit && !dirty)}
              className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              {isEdit ? "Save changes" : "Publish announcement"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ─── Top-level client ─────────────────────────────────────────────

export default function AnnouncementsLuxuryClient({
  initial,
  kpis,
}: {
  initial: EnrichedAnnouncement[];
  kpis: AnnouncementsKpis | null;
}) {
  const [items, setItems] = React.useState<EnrichedAnnouncement[]>(initial);
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<AnnouncementStatus | "all">("all");
  const [kindFilter, setKindFilter] = React.useState<string>("all");
  const [sevFilter, setSevFilter] = React.useState<string>("all");
  // Editor target: null = closed, "new" = create mode, row = edit mode.
  // (Was `creating: boolean` — extended for the dual-mode editor.)
  const [editor, setEditor] = React.useState<EnrichedAnnouncement | "new" | null>(null);

  function refresh() {
    window.location.reload();
  }

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((a) => {
      if (statusFilter !== "all" && a.status !== statusFilter) return false;
      if (kindFilter !== "all" && a.kind !== kindFilter) return false;
      if (sevFilter !== "all" && a.severity !== sevFilter) return false;
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        a.body.toLowerCase().includes(q)
      );
    });
  }, [items, query, statusFilter, kindFilter, sevFilter]);

  return (
    <div className="space-y-6">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 -mx-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-slate-500" />
          <div>
            <div className="text-sm font-medium text-slate-900">Customer Communications</div>
            <div className="text-[11px] text-slate-500">
              {kpis
                ? `${kpis.activeAnnouncements} active · ${kpis.totalDeliveries} deliveries all time`
                : "Loading…"}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setEditor("new")}
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition-all hover:-translate-y-px hover:bg-slate-800"
        >
          <Plus className="h-3 w-3" />
          New announcement
        </button>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile
          label="Active"
          value={<AnimatedCounter value={kpis?.activeAnnouncements ?? 0} />}
          hint="status=active · not expired · published"
          tone="growth"
        />
        <KpiTile
          label="Deliveries"
          value={<AnimatedCounter value={kpis?.totalDeliveries ?? 0} />}
          hint={kpis ? `${kpis.totalViews} views · ${kpis.totalClicks} clicks` : "—"}
        />
        <KpiTile
          label="Engagement rate"
          value={kpis ? pct(kpis.engagementRate) : "—"}
          hint={kpis?.engagementRate === null ? "no deliveries yet" : "views / deliveries"}
        />
        <KpiTile
          label="Expiring soon"
          value={<AnimatedCounter value={kpis?.expiringSoon ?? 0} />}
          hint="within 7 days"
          tone={kpis && kpis.expiringSoon > 0 ? "warning" : "neutral"}
        />
      </div>

      {/* Top performer callout */}
      {kpis?.topEngagement ? (
        <div className="rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50/40 to-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100">
                <Sparkles className="h-4 w-4 text-emerald-700" />
              </div>
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-emerald-700">
                  Highest engagement
                </div>
                <div className="text-sm font-medium text-slate-900">{kpis.topEngagement.title}</div>
              </div>
            </div>
            <div className="text-right">
              <div
                className="text-[22px] font-semibold leading-none text-emerald-700"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {kpis.topEngagement.viewCount}
              </div>
              <div className="text-[10px] text-emerald-600">
                views
                {kpis.topEngagement.deliveryCount > 0
                  ? ` · ${Math.round((kpis.topEngagement.viewCount / kpis.topEngagement.deliveryCount) * 100)}%`
                  : ""}
              </div>
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
            placeholder="Search title or body…"
            className="w-56 rounded-md border border-slate-200 py-1.5 pl-7 pr-3 text-[13px] focus:border-slate-400 focus:outline-none"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as AnnouncementStatus | "all")}
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
          <option value="all">All kinds</option>
          {Object.entries(KIND_META).map(([k, m]) => (
            <option key={k} value={k}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          value={sevFilter}
          onChange={(e) => setSevFilter(e.target.value)}
          className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px]"
        >
          <option value="all">All severities</option>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="critical">Critical</option>
        </select>
        <div className="ml-auto text-[11px] text-slate-500">
          {filtered.length} of {items.length}
        </div>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        items.length === 0 ? (
          <PremiumEmptyState
            icon={<MessageSquare />}
            title="No announcements yet"
            description="Compose your first announcement to reach tenants with release notes, maintenance windows, or engagement nudges. Audience targeting + delivery channels are configurable per send."
            cta={{ label: "Create announcement", onClick: () => setEditor("new") }}
            tone="info"
          />
        ) : (
          <PremiumEmptyState
            icon={<Search />}
            title="No announcements match your filters"
            description="Try clearing a filter or searching for different text."
            tone="neutral"
          />
        )
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((a) => (
            <AnnouncementCard
              key={a.id}
              a={a}
              onEdit={() => setEditor(a)}
              onArchive={() => {
                if (confirm(`Archive "${a.title}"?`)) {
                  void fetch(`/api/admin/announcements/${a.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ active: false }),
                  }).then(() => refresh());
                }
              }}
            />
          ))}
        </div>
      )}

      <AnnouncementBuilderModal
        open={editor !== null}
        existing={editor && editor !== "new" ? editor : null}
        onClose={() => setEditor(null)}
        onSaved={refresh}
      />
    </div>
  );
}

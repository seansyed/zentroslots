"use client";

/**
 * Business Phone add-on card for the billing page (Phase 4). Tenant ADMIN only
 * (the page renders it only for admins). Lets the admin add/remove the add-on
 * via POST /api/tenant/phone/addon and shows the correct setup state.
 *
 * Entitlement is webhook-driven — after the Stripe mutation we refresh so the
 * server-computed status updates. Honest copy: the softphone is "coming soon",
 * not live. Shows no Stripe/Telnyx ids or secrets (status is pre-masked).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Phone, CheckCircle2, Hourglass, AlertTriangle, Loader2 } from "lucide-react";

import { BUSINESS_PHONE_ADDON_CARD } from "@/lib/business-phone-ui";
import type { BusinessPhoneClientStatus } from "@/lib/business-phone-admin";

export default function BusinessPhoneAddonCard({ status }: { status: BusinessPhoneClientStatus }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function act(action: "add" | "remove") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tenant/phone/addon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        // Safe handling of 403 / 409 / 503.
        throw new Error(
          data?.error ||
            (res.status === 503
              ? "The Business Phone add-on isn't available yet."
              : res.status === 409
                ? "Subscribe to a base plan first."
                : res.status === 403
                  ? "Only the workspace admin can change this."
                  : "Something went wrong. Please try again."),
        );
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const card = BUSINESS_PHONE_ADDON_CARD;
  const active = status.addonSubscribed && !status.suspended;

  return (
    <div className="rounded-2xl border border-border/60 bg-surface p-4 shadow-soft sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
            <Phone className="h-4 w-4" strokeWidth={1.75} />
          </span>
          <div>
            <h3 className="text-[14px] font-semibold tracking-tight text-ink">{card.title} add-on</h3>
            <div className="mt-0.5 text-[13px] font-medium text-ink">{card.price}</div>
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      <ul className="mt-3 grid gap-1 text-[12px] text-ink sm:grid-cols-2">
        {card.features.map((f) => (
          <li key={f} className="flex items-start gap-1.5">
            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" strokeWidth={2.25} />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-ink-subtle">
        {card.limitations.join(" · ")}.
      </p>

      {/* State-specific line */}
      <StateLine status={status} />

      {error ? (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
          {error}
        </div>
      ) : null}

      {/* Actions */}
      <div className="mt-4">
        {status.internalAccount ? (
          // Internal/super-admin tenant: no Stripe purchase path. Managed by a
          // super admin via /admin/business-phone. Never calls the Stripe route.
          <p className="text-[12px] text-ink-muted">
            <span className="font-medium text-ink">Internal Enterprise account.</span> Business Phone can be
            enabled manually by a super admin — no Stripe purchase required.
          </p>
        ) : status.suspended ? (
          <p className="text-[12px] font-medium text-red-700">
            Billing is suspended — update your payment method to restore Business Phone.
          </p>
        ) : active ? (
          <button
            type="button"
            onClick={() => act("remove")}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-muted hover:bg-surface-inset disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Remove Business Phone
          </button>
        ) : status.baseSubscriptionActive ? (
          <button
            type="button"
            onClick={() => act("add")}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-accent px-3 py-1.5 text-[12px] font-semibold text-white shadow-soft hover:bg-brand-hover disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Add Business Phone — $19/mo
          </button>
        ) : (
          <div>
            <button
              type="button"
              disabled
              className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md border border-border bg-surface-inset/40 px-3 py-1.5 text-[12px] font-medium text-ink-subtle"
            >
              Add Business Phone — $19/mo
            </button>
            <p className="mt-1.5 text-[11.5px] text-ink-muted">Subscribe to a base plan first.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: BusinessPhoneClientStatus }) {
  if (status.internalAccount) {
    return <Badge tone="slate" icon={CheckCircle2} label="Internal" />;
  }
  if (status.suspended) {
    return <Badge tone="red" icon={AlertTriangle} label="Suspended" />;
  }
  if (!status.addonSubscribed) return null;
  switch (status.setupState) {
    case "setup_pending":
      return <Badge tone="amber" icon={Hourglass} label="Setup pending" />;
    case "cap_reached":
      return <Badge tone="amber" icon={AlertTriangle} label="Cap reached" />;
    case "disabled":
      return <Badge tone="slate" icon={AlertTriangle} label="Disabled" />;
    default:
      return <Badge tone="green" icon={CheckCircle2} label="Active" />;
  }
}

function StateLine({ status }: { status: BusinessPhoneClientStatus }) {
  if (status.suspended) return null;
  if (!status.addonSubscribed) return null;
  let msg: string | null = null;
  if (status.setupState === "setup_pending") {
    msg =
      "Business Phone is active. Your number setup is pending. ParaFort will assign your business number and forwarding line shortly.";
  } else if (status.setupState === "cap_reached") {
    msg = "You've used this month's included minutes. Outbound calling resumes next cycle.";
  } else if (status.setupState === "active") {
    msg = status.businessNumberMasked
      ? `Ready. Your business number ${status.businessNumberMasked} is live.`
      : "Ready.";
  } else if (status.setupState === "disabled") {
    msg = "Business Phone is currently disabled for your workspace.";
  }
  if (!msg) return null;
  return <p className="mt-3 text-[12px] text-ink-muted">{msg}</p>;
}

function Badge({
  tone,
  icon: Icon,
  label,
}: {
  tone: "green" | "amber" | "red" | "slate";
  icon: typeof CheckCircle2;
  label: string;
}) {
  const cls =
    tone === "green"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
      : tone === "amber"
        ? "bg-amber-50 text-amber-700 ring-amber-200/40"
        : tone === "red"
          ? "bg-red-50 text-red-700 ring-red-200/40"
          : "bg-surface-inset text-ink-subtle ring-border/40";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${cls}`}>
      <Icon className="h-3 w-3" strokeWidth={2} />
      {label}
    </span>
  );
}

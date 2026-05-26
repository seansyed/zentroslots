"use client";

/**
 * PremiumEmptyState — opinionated empty-state primitive.
 *
 * Three slots: icon, title, description, optional CTA. Designed to
 * feel intentional, not "you have no data" gray.
 *
 *   <PremiumEmptyState
 *     icon={<Briefcase />}
 *     title="No tenants yet"
 *     description="When new workspaces sign up, they'll appear here."
 *     cta={{ label: "Run simulation", href: "/admin/dev/simulation" }}
 *   />
 */

import * as React from "react";
import Link from "next/link";

type Props = {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  cta?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
  /** Visual variant. */
  tone?: "neutral" | "info" | "success" | "warning";
  className?: string;
};

const TONE_STYLES: Record<NonNullable<Props["tone"]>, { wrap: string; iconWrap: string }> = {
  neutral: {
    wrap: "border-slate-200 bg-gradient-to-br from-white to-slate-50/40",
    iconWrap: "bg-slate-100 text-slate-600",
  },
  info: {
    wrap: "border-sky-200 bg-gradient-to-br from-white to-sky-50/40",
    iconWrap: "bg-sky-100 text-sky-700",
  },
  success: {
    wrap: "border-emerald-200 bg-gradient-to-br from-white to-emerald-50/30",
    iconWrap: "bg-emerald-100 text-emerald-700",
  },
  warning: {
    wrap: "border-amber-200 bg-gradient-to-br from-white to-amber-50/30",
    iconWrap: "bg-amber-100 text-amber-700",
  },
};

export function PremiumEmptyState({
  icon,
  title,
  description,
  cta,
  tone = "neutral",
  className,
}: Props) {
  const t = TONE_STYLES[tone];
  return (
    <div
      className={`rounded-xl border ${t.wrap} px-6 py-10 text-center shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${className ?? ""}`}
    >
      {icon ? (
        <div
          className={`mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full ${t.iconWrap}`}
        >
          <span className="[&_svg]:h-5 [&_svg]:w-5">{icon}</span>
        </div>
      ) : null}
      <div className="text-[15px] font-medium text-slate-900">{title}</div>
      {description ? (
        <div className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-slate-500">
          {description}
        </div>
      ) : null}
      {cta ? (
        <div className="mt-4">
          {cta.href ? (
            <Link
              href={cta.href}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[13px] font-medium text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:-translate-y-px hover:border-slate-300 hover:shadow-[0_4px_12px_rgba(15,23,42,0.06)]"
            >
              {cta.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={cta.onClick}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[13px] font-medium text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:-translate-y-px hover:border-slate-300 hover:shadow-[0_4px_12px_rgba(15,23,42,0.06)]"
            >
              {cta.label}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

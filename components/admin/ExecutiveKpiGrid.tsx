/**
 * Executive KPI grid — 16 platform-wide metrics in a single grid.
 *
 * Server component. Receives a pre-computed KpiBundle so server-side
 * rendering can stream the first paint without a client roundtrip.
 *
 * Layout: responsive 2/3/4-column grid. On mobile two-up so the most
 * important KPIs land above the fold; on desktop four-up for fast scan.
 *
 * Per-card error isolation: a failed KPI shows an inline error chip
 * inside its card, the other 15 render normally.
 */

import * as React from "react";
import {
  Banknote,
  Briefcase,
  Calendar as CalendarIcon,
  CheckCircle2,
  CreditCard,
  DollarSign,
  Mail,
  Sparkles,
  TrendingUp,
  Users,
  UserPlus,
  AlertTriangle,
  Activity,
} from "lucide-react";

import KpiCard from "./KpiCard";
import type { KpiBundle } from "@/lib/admin-analytics/kpis";
import { kpiTooltip } from "@/lib/admin-analytics/kpis";

export default function ExecutiveKpiGrid({ bundle }: { bundle: KpiBundle }) {
  const iconCls = "h-3 w-3";
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
      <KpiCard label="Total MRR" tooltip={kpiTooltip("totalMrr")} icon={<DollarSign className={iconCls} />} result={bundle.totalMrr} />
      <KpiCard label="ARR Projection" tooltip={kpiTooltip("arrProjection")} icon={<TrendingUp className={iconCls} />} result={bundle.arrProjection} />
      <KpiCard label="Active Paid Tenants" tooltip={kpiTooltip("activePaidTenants")} icon={<Briefcase className={iconCls} />} result={bundle.activePaidTenants} />
      <KpiCard label="Trialing" tooltip={kpiTooltip("trialingTenants")} icon={<Sparkles className={iconCls} />} result={bundle.trialingTenants} />
      <KpiCard label="Churned (This Month)" tooltip={kpiTooltip("churnedThisMonth")} icon={<AlertTriangle className={iconCls} />} result={bundle.churnedThisMonth} />
      <KpiCard label="Failed Payments (30d)" tooltip={kpiTooltip("failedPayments30d")} icon={<CreditCard className={iconCls} />} result={bundle.failedPayments30d} />
      <KpiCard label="New Signups (7d)" tooltip={kpiTooltip("newSignups7d")} icon={<UserPlus className={iconCls} />} result={bundle.newSignups7d} />
      <KpiCard label="New Signups (30d)" tooltip={kpiTooltip("newSignups30d")} icon={<UserPlus className={iconCls} />} result={bundle.newSignups30d} />
      <KpiCard label="Total Bookings" tooltip={kpiTooltip("totalBookings")} icon={<CalendarIcon className={iconCls} />} result={bundle.totalBookings} />
      <KpiCard label="Booking Growth (30d)" tooltip={kpiTooltip("bookingGrowthPct")} icon={<Activity className={iconCls} />} result={bundle.bookingGrowthPct} />
      <KpiCard label="Total Active Users" tooltip={kpiTooltip("totalActiveUsers")} icon={<Users className={iconCls} />} result={bundle.totalActiveUsers} />
      <KpiCard label="Avg Bookings / Tenant" tooltip={kpiTooltip("avgBookingsPerTenant")} icon={<Activity className={iconCls} />} result={bundle.avgBookingsPerTenant} />
      <KpiCard label="Trial → Paid Conversion" tooltip={kpiTooltip("trialConversionPct")} icon={<CheckCircle2 className={iconCls} />} result={bundle.trialConversionPct} />
      <KpiCard label="Avg Revenue / Tenant" tooltip={kpiTooltip("avgRevenuePerTenant")} icon={<Banknote className={iconCls} />} result={bundle.avgRevenuePerTenant} />
      <KpiCard label="Highest Growth Tenant" tooltip={kpiTooltip("highestGrowthTenant")} icon={<TrendingUp className={iconCls} />} result={bundle.highestGrowthTenant} />
      <KpiCard label="Email Delivery" tooltip={kpiTooltip("emailDeliverySuccessPct")} icon={<Mail className={iconCls} />} result={bundle.emailDeliverySuccessPct} />
      <KpiCard label="Calendar Sync Health" tooltip={kpiTooltip("calendarSyncHealthPct")} icon={<CalendarIcon className={iconCls} />} result={bundle.calendarSyncHealthPct} />
    </div>
  );
}

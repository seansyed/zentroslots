type Status =
  | "pending"
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show"
  // Paid-booking lifecycle (0030). Reuses neighbor visual treatments.
  | "pending_payment"
  | "payment_failed"
  | "refunded";

const STYLES: Record<Status, string> = {
  pending:   "bg-amber-50 text-amber-700 border-amber-200",
  confirmed: "bg-green-50 text-green-700 border-green-200",
  cancelled: "bg-slate-100 text-slate-600 border-slate-200 line-through decoration-slate-400",
  completed: "bg-blue-50 text-blue-700 border-blue-200",
  no_show:   "bg-red-50 text-red-700 border-red-200",
  pending_payment: "bg-amber-50 text-amber-700 border-amber-200",
  payment_failed:  "bg-red-50 text-red-700 border-red-200",
  refunded:        "bg-slate-100 text-slate-600 border-slate-200 line-through decoration-slate-400",
};

const LABELS: Record<Status, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  completed: "Completed",
  no_show: "No-show",
  pending_payment: "Awaiting payment",
  payment_failed: "Payment failed",
  refunded: "Refunded",
};

export default function StatusBadge({ status }: { status: Status }) {
  return (
    <span
      className={
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium " +
        (STYLES[status] ?? "bg-slate-100 text-slate-600 border-slate-200")
      }
    >
      {LABELS[status] ?? status}
    </span>
  );
}

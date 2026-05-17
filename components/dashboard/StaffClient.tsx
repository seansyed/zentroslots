"use client";

import * as React from "react";
import { Avatar, Badge, Button, Card, Drawer, EmptyState, Skeleton, toast } from "@/components/ui/primitives";
import ActivityTimeline from "@/components/dashboard/ActivityTimeline";

type StaffRow = {
  id: string;
  name: string;
  email: string;
  timezone: string;
  avatarUrl: string | null;
  bio: string | null;
  specialties: string | null;
  googleConnected: boolean;
  upcomingCount: number;
  completedThisMonth: number;
  role?: "staff" | "manager";
};

type ServiceItem = { id: string; name: string; durationMinutes: number; color: string | null };

type StaffDetail = {
  staff: StaffRow & { primaryLocationId: string | null; departmentId: string | null; role: "staff" | "manager" };
  assignedServices: { id: string; name: string }[];
  weeklyAvailability: { dayOfWeek: number; startTime: string; endTime: string }[];
  stats: { completed30d: number; cancelled30d: number };
  upcoming: {
    id: string; startAt: string; endAt: string; status: string;
    clientName: string; clientEmail: string; meetLink: string | null; serviceName: string;
  }[];
};

const TABS = ["overview", "services", "schedule", "activity"] as const;
type Tab = (typeof TABS)[number];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function StaffClient({
  isAdmin,
  canChangeRoles,
  allServices,
}: {
  userTimezone: string;
  // `isAdmin` here is the legacy name; it now means "admin OR manager" —
  // i.e. who can edit staff records & service assignments.
  isAdmin: boolean;
  // Strictly admin-only: who can promote/demote between staff and manager.
  canChangeRoles: boolean;
  allServices: ServiceItem[];
}) {
  const [rows, setRows] = React.useState<StaffRow[] | null>(null);
  const [openId, setOpenId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/staff")
      .then((r) => r.json())
      .then((d) => !cancelled && setRows(Array.isArray(d) ? d : []))
      .catch(() => !cancelled && setRows([]));
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="mt-6 space-y-4">
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-xs">
        {rows === null ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No staff yet"
            body="Invite staff from the sign-up flow with your workspace slug, or via the bookings flow."
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-subtle text-left text-xs uppercase text-ink-subtle">
              <tr>
                <th className="px-4 py-2.5">Staff member</th>
                <th className="px-4 py-2.5">Upcoming</th>
                <th className="px-4 py-2.5">Completed (mo)</th>
                <th className="px-4 py-2.5">Timezone</th>
                <th className="px-4 py-2.5">Calendar</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => setOpenId(s.id)}
                  className="cursor-pointer border-t border-border align-top transition hover:bg-surface-inset/60"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={s.name} src={s.avatarUrl} size="sm" />
                      <div>
                        <div className="text-ink">{s.name}</div>
                        <div className="text-xs text-ink-subtle">{s.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-ink">{s.upcomingCount}</td>
                  <td className="px-4 py-3 text-ink">{s.completedThisMonth}</td>
                  <td className="px-4 py-3 text-xs text-ink-muted">{s.timezone}</td>
                  <td className="px-4 py-3">
                    {s.googleConnected
                      ? <Badge tone="green">Connected</Badge>
                      : <Badge tone="neutral">Not connected</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <StaffDrawer
        id={openId}
        onClose={() => setOpenId(null)}
        allServices={allServices}
        isAdmin={isAdmin}
        canChangeRoles={canChangeRoles}
      />
    </div>
  );
}

function StaffDrawer({
  id, onClose, allServices, isAdmin, canChangeRoles,
}: {
  id: string | null;
  onClose: () => void;
  allServices: ServiceItem[];
  isAdmin: boolean;
  canChangeRoles: boolean;
}) {
  const [data, setData] = React.useState<StaffDetail | null>(null);
  const [tab, setTab] = React.useState<Tab>("overview");
  const [savingServices, setSavingServices] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [roleSaving, setRoleSaving] = React.useState(false);

  React.useEffect(() => {
    if (!id) { setData(null); return; }
    setData(null);
    setTab("overview");
    fetch(`/api/staff/${id}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setSelected(new Set(d.assignedServices.map((s: { id: string }) => s.id)));
      })
      .catch(() => toast("Failed to load staff", "error"));
  }, [id]);

  async function saveServices() {
    if (!id) return;
    setSavingServices(true);
    try {
      const res = await fetch(`/api/staff/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceIds: Array.from(selected) }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      toast("Service assignments saved", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setSavingServices(false);
    }
  }

  function toggleService(sid: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  }

  async function changeRole(next: "staff" | "manager") {
    if (!id || !data || data.staff.role === next) return;
    setRoleSaving(true);
    try {
      const res = await fetch(`/api/staff/${id}/role`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: next }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      setData((prev) => prev ? { ...prev, staff: { ...prev.staff, role: d.role } } : prev);
      toast(`Role changed to ${d.role}`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setRoleSaving(false);
    }
  }

  const open = Boolean(id);
  const weekly = new Map((data?.weeklyAvailability ?? []).map((r) => [r.dayOfWeek, r]));

  return (
    <Drawer open={open} onClose={onClose} side="right" ariaLabel="Staff">
      {!data ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-6 h-24 w-full" />
        </div>
      ) : (
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between gap-3 border-b border-border p-5">
            <div className="flex items-center gap-3">
              <Avatar name={data.staff.name} src={data.staff.avatarUrl} size="lg" />
              <div>
                <h2 className="text-lg font-semibold text-ink">{data.staff.name}</h2>
                <a className="text-sm text-brand-accent hover:underline" href={`mailto:${data.staff.email}`}>
                  {data.staff.email}
                </a>
                <div className="mt-0.5 text-xs text-ink-muted">{data.staff.timezone}</div>
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-inset hover:text-ink"
            >×</button>
          </div>

          <div className="flex gap-1 border-b border-border px-3">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  "border-b-2 px-3 py-2 text-sm capitalize transition " +
                  (t === tab ? "border-brand-accent font-medium text-brand-accent" : "border-transparent text-ink-muted hover:text-ink")
                }
              >
                {t}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            {tab === "overview" && (
              <div className="space-y-4">
                <Card>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">Role</div>
                      <div className="mt-1 flex items-center gap-2">
                        <Badge tone={data.staff.role === "manager" ? "violet" : "neutral"} className="capitalize">{data.staff.role}</Badge>
                        {data.staff.role === "manager" && (
                          <span className="text-xs text-ink-muted">Sees all bookings & manages workspace ops.</span>
                        )}
                      </div>
                    </div>
                    {canChangeRoles && (
                      <div className="flex items-center gap-2">
                        <select
                          value={data.staff.role}
                          disabled={roleSaving}
                          onChange={(e) => changeRole(e.target.value as "staff" | "manager")}
                          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                        >
                          <option value="staff">Staff</option>
                          <option value="manager">Manager</option>
                        </select>
                      </div>
                    )}
                  </div>
                </Card>
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Upcoming" value={String(data.upcoming.length)} />
                  <Stat label="Completed (30d)" value={String(data.stats.completed30d)} />
                  <Stat label="Cancelled (30d)" value={String(data.stats.cancelled30d)} />
                  <Stat label="Services offered" value={String(data.assignedServices.length)} />
                </div>
                {data.staff.bio && (
                  <Card>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">Bio</div>
                    <p className="mt-1 text-sm text-ink">{data.staff.bio}</p>
                  </Card>
                )}
                {data.staff.specialties && (
                  <Card>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">Specialties</div>
                    <p className="mt-1 text-sm text-ink">{data.staff.specialties}</p>
                  </Card>
                )}
              </div>
            )}

            {tab === "services" && (
              <div>
                {!isAdmin && (
                  <div className="mb-3 text-xs text-ink-muted">Read-only. Admins can change service assignments.</div>
                )}
                <div className="space-y-2">
                  {allServices.length === 0 && (
                    <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-ink-subtle">
                      No services in this workspace.
                    </div>
                  )}
                  {allServices.map((svc) => {
                    const on = selected.has(svc.id);
                    return (
                      <label key={svc.id} className={"flex cursor-pointer items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-sm transition " + (on ? "ring-2 ring-brand-accent/30" : "hover:bg-surface-inset")}>
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!isAdmin}
                          onChange={() => toggleService(svc.id)}
                          className="h-4 w-4 accent-brand-accent"
                        />
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: svc.color ?? "#94a3b8" }}
                          aria-hidden
                        />
                        <span className="flex-1 text-ink">{svc.name}</span>
                        <span className="text-xs text-ink-subtle">{svc.durationMinutes} min</span>
                      </label>
                    );
                  })}
                </div>
                {isAdmin && (
                  <div className="mt-4 flex justify-end">
                    <Button onClick={saveServices} disabled={savingServices}>
                      {savingServices ? "Saving…" : "Save services"}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {tab === "schedule" && (
              <div>
                <div className="mb-3 text-xs text-ink-muted">Weekly availability (read-only here — edit on the working hours page).</div>
                <div className="space-y-1.5">
                  {DAYS.map((label, d) => {
                    const rule = weekly.get(d);
                    return (
                      <div key={d} className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2 text-sm">
                        <span className="w-12 text-ink">{label}</span>
                        {rule ? (
                          <span className="text-ink-muted">{rule.startTime.slice(0,5)} – {rule.endTime.slice(0,5)}</span>
                        ) : (
                          <span className="text-ink-subtle">Off</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {tab === "activity" && (
              <ActivityTimeline entityType="booking" limit={30} />
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
    </Card>
  );
}

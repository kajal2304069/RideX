import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { get, post } from "@/lib/api";
import { dt, inr, humanize } from "@/lib/format";
import { Badge, Button, Empty, Field, Loading, Modal, PageHeader, Panel, Stat, StatusBadge, Tabs, ErrorNote } from "@/components/ui";
import { useAction } from "@/hooks/useApi";

type Tab = "overview" | "users" | "rides" | "payments" | "audit" | "health";
interface Page<T> { items: T[]; nextCursor: string | null }

const useList = <T,>(path: string, enabled = true) => useQuery({ queryKey: ["admin", path], enabled, queryFn: () => get<Page<T>>(path, { limit: 50 }) });

function Table({ cols, rows, empty }: { cols: Array<{ h: string; c: (r: any) => React.ReactNode; num?: boolean }>; rows: any[]; empty: string }) {
  if (!rows.length) return <Empty title={empty} />;
  return (
    <div className="overflow-x-auto border border-rule bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-rule bg-concrete"><tr>{cols.map((c) => <th key={c.h} className="px-3 py-2 font-semibold">{c.h}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id} className="border-b border-rule last:border-b-0">{cols.map((c) => <td key={c.h} className={`px-3 py-2 ${c.num ? "num" : ""}`}>{c.c(r)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Series({ metric, title, money }: { metric: string; title: string; money?: boolean }) {
  const q = useQuery({ queryKey: ["admin", "ts", metric], queryFn: () => get<{ points: Array<{ bucket: string; value: number }> }>("/analytics/timeseries", { metric, bucket: "day" }) });
  const data = (q.data?.points ?? []).map((p) => ({ d: new Date(p.bucket).toLocaleDateString("en-IN", { day: "numeric", month: "short" }), v: p.value }));
  return (
    <Panel title={title}>
      {q.isLoading ? <Loading /> : (
        <div style={{ height: 200 }} role="img" aria-label={`${title} over the last 30 days`}>
          <ResponsiveContainer>
            <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid stroke="#E3E6F1" vertical={false} />
              <XAxis dataKey="d" tick={{ fontSize: 11 }} interval={4} stroke="#44546A" />
              <YAxis tick={{ fontSize: 11 }} width={44} stroke="#44546A" tickFormatter={(v) => (money ? `₹${v}` : String(v))} />
              <Tooltip formatter={(v: number) => [money ? inr(v) : v, title]} />
              <Line type="linear" dataKey="v" stroke="#1B1FD0" strokeWidth={2.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}

function Overview() {
  const o = useQuery({ queryKey: ["admin", "overview"], queryFn: () => get<any>("/analytics/overview") });
  const r = useQuery({ queryKey: ["admin", "revenue"], queryFn: () => get<any>("/analytics/revenue") });
  const lb = useQuery({ queryKey: ["admin", "leaders"], queryFn: () => get<any>("/analytics/leaderboards") });
  if (o.isLoading) return <Loading />;
  if (!o.data) return <ErrorNote error={o.error} />;
  const d = o.data;
  const roles = Object.entries(d.users.byRole as Record<string, number>).map(([k, v]) => ({ role: humanize(k), n: v }));
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Panel><Stat label="Users" value={d.users.total} note={`${d.users.newInRange} new this month`} /></Panel>
        <Panel><Stat label="Drivers online" value={`${d.drivers.online} / ${d.drivers.total}`} /></Panel>
        <Panel><Stat label="Rides (30 d)" value={d.rides.total} note={`${Math.round(d.rides.completionRate * 100)}% completed`} /></Panel>
        <Panel><Stat label="Platform commission" value={inr(r.data?.commission.total ?? 0)} note={`${inr(r.data?.collected.gross ?? 0)} collected`} /></Panel>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Series metric="rides" title="Rides per day" />
        <Series metric="gmv" title="Money collected per day" money />
        <Series metric="signups" title="Sign-ups per day" />
        <Panel title="Users by role">
          <div style={{ height: 200 }} role="img" aria-label="Users by role">
            <ResponsiveContainer><BarChart data={roles} layout="vertical" margin={{ left: 30 }}>
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} /><YAxis type="category" dataKey="role" tick={{ fontSize: 11 }} width={90} />
              <Tooltip /><Bar dataKey="n" fill="#1B1FD0" />
            </BarChart></ResponsiveContainer>
          </div>
        </Panel>
      </div>
      {lb.data && <Panel title="Top earners"><pre className="num overflow-x-auto text-xs">{JSON.stringify(lb.data, null, 1).slice(0, 1200)}</pre></Panel>}
    </div>
  );
}

function Users() {
  const q = useList<any>("/admin/users");
  const [target, setTarget] = useState<{ u: any; on: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const act = useAction(() => post(`/admin/users/${target!.u.id}/${target!.on ? "activate" : "deactivate"}`, { reason }), { ok: "Done. This is recorded in the audit log.", invalidate: [["admin"]], onDone: () => { setTarget(null); setReason(""); } });
  if (q.isLoading) return <Loading />;
  return (
    <>
      <Table empty="No users" rows={q.data?.items ?? []} cols={[
        { h: "Name", c: (u) => <><strong>{u.fullName}</strong><br /><span className="text-xs text-mute">{u.email}</span></> },
        { h: "Roles", c: (u) => u.roles.map(humanize).join(", ") },
        { h: "Status", c: (u) => (u.isActive ? <Badge tone="good">Active</Badge> : <Badge tone="bad" >Deactivated</Badge>) },
        { h: "Joined", c: (u) => dt(u.createdAt) },
        { h: "", c: (u) => (u.roles.includes("ADMIN") ? null : <Button size="sm" variant="ghost" onClick={() => setTarget({ u, on: !u.isActive })}>{u.isActive ? "Deactivate" : "Reactivate"}</Button>) },
      ]} />
      {target && (
        <Modal title={`${target.on ? "Reactivate" : "Deactivate"} ${target.u.fullName}`} onClose={() => setTarget(null)}>
          <Field label="Reason (kept in the audit log)">{(i) => <input id={i} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={() => setTarget(null)}>Cancel</Button><Button variant={target.on ? "primary" : "danger"} disabled={reason.trim().length < 3} busy={act.isPending} onClick={() => act.mutate(undefined)}>Confirm</Button></div>
        </Modal>
      )}
    </>
  );
}

function Health() {
  const q = useQuery({ queryKey: ["admin", "health"], queryFn: () => get<any>("/admin/system/health"), refetchInterval: 10000 });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorNote error={q.error} />;
  const h = q.data;
  const tone = h.status === "ok" ? "good" : h.status === "degraded" ? "warn" : "bad";
  return (
    <div className="space-y-5">
      <Panel title="Overall" action={<Badge tone={tone}>{h.status.toUpperCase()}</Badge>}>
        <p className="text-sm text-mute">Checked {dt(h.checkedAt)} · uptime {Math.round(h.process.uptimeSeconds / 60)} min · {h.process.rssMb} MB RSS · {h.realtime.websocketClients} live sockets</p>
        {h.alerts.length > 0 && <ul className="mt-2 list-disc pl-5 text-repair-ink">{h.alerts.map((a: string) => <li key={a}>{a}</li>)}</ul>}
      </Panel>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Dependencies"><ul className="divide-y divide-rule">{Object.entries(h.dependencies).map(([k, v]: any) => <li key={k} className="flex justify-between py-2"><span>{humanize(k)}</span><span className="num">{v.latencyMs} ms <StatusBadge status={v.status.toUpperCase()} /></span></li>)}</ul></Panel>
        <Panel title="Queues"><ul className="divide-y divide-rule">{h.queues.map((x: any) => <li key={x.name} className="flex justify-between py-2"><span>{x.name}</span><span className="num text-sm">{x.waiting} waiting · {x.active} active · {x.failed} failed</span></li>)}</ul></Panel>
        <Panel title="Business checks" className="lg:col-span-2"><div className="grid grid-cols-2 gap-4 sm:grid-cols-5">{Object.entries(h.invariants).map(([k, v]: any) => <Stat key={k} label={humanize(k.replace(/([A-Z])/g, " $1"))} value={<span className={v ? "text-repair-ink" : ""}>{v}</span>} />)}</div><p className="mt-3 text-xs text-mute">Anything above zero means money or a booking is stuck and needs a look.</p></Panel>
      </div>
    </div>
  );
}

export function Admin() {
  const [tab, setTab] = useState<Tab>("overview");
  const rides = useList<any>("/admin/rides", tab === "rides");
  const pays = useList<any>("/admin/payments", tab === "payments");
  const audit = useList<any>("/admin/audit-logs", tab === "audit");
  return (
    <div data-line="admin">
      <PageHeader title="Admin console" sub="Everything on the platform, with every change written to the audit log." />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "overview", label: "Overview" }, { id: "users", label: "Users" }, { id: "rides", label: "Rides" }, { id: "payments", label: "Payments" }, { id: "audit", label: "Audit log" }, { id: "health", label: "System health" }]} />
      <div className="mt-5">
        {tab === "overview" && <Overview />}
        {tab === "users" && <Users />}
        {tab === "rides" && (rides.isLoading ? <Loading /> : <Table empty="No rides yet" rows={rides.data?.items ?? []} cols={[
          { h: "Status", c: (r) => <StatusBadge status={r.status} /> }, { h: "Pickup", c: (r) => r.pickupAddress ?? "–" }, { h: "Drop-off", c: (r) => r.dropoffAddress ?? "–" },
          { h: "Fare", c: (r) => (r.totalFare != null ? inr(r.totalFare) : "–"), num: true }, { h: "Requested", c: (r) => dt(r.requestedAt) }]} />)}
        {tab === "payments" && (pays.isLoading ? <Loading /> : <Table empty="No payments yet" rows={pays.data?.items ?? []} cols={[
          { h: "Type", c: (p) => humanize(p.payableType) }, { h: "Amount", c: (p) => inr(p.amount), num: true }, { h: "Status", c: (p) => <StatusBadge status={p.status} /> },
          { h: "Provider", c: (p) => p.provider }, { h: "When", c: (p) => dt(p.createdAt) }]} />)}
        {tab === "audit" && (audit.isLoading ? <Loading /> : <Table empty="No audit entries" rows={audit.data?.items ?? []} cols={[
          { h: "When", c: (a) => dt(a.createdAt) }, { h: "Who", c: (a) => a.actorEmail ?? "system" }, { h: "Action", c: (a) => a.action },
          { h: "Target", c: (a) => `${a.entityType} ${String(a.entityId ?? "").slice(0, 8)}` }, { h: "Details", c: (a) => <code className="text-xs">{JSON.stringify(a.metadata)}</code> }]} />)}
        {tab === "health" && <Health />}
      </div>
    </div>
  );
}

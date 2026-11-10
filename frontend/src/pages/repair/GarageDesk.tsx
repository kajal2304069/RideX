import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, post, put } from "@/lib/api";
import { dt, inr } from "@/lib/format";
import { Badge, Button, Empty, Field, Loading, Modal, PageHeader, Panel, Tabs, StatusBadge } from "@/components/ui";
import { useAction } from "@/hooks/useApi";
import { Garage, Mechanic, RepairBooking } from "./repairTypes";

function OrderModal({ b, onClose }: { b: RepairBooking; onClose: () => void }) {
  const [f, setF] = useState({ diagnosis: "", workPerformed: "", labor: "", partName: "", partQty: "1", partPrice: "" });
  const [parts, setParts] = useState<Array<{ name: string; quantity: number; unitPrice: number }>>([]);
  const save = useAction(() => put(`/bookings/${b.id}/repair-order`, { diagnosis: f.diagnosis || undefined, workPerformed: f.workPerformed || undefined, partsUsed: parts, laborCost: Number(f.labor || 0) }), { ok: "Repair order saved", invalidate: [["garage-desk"]], onDone: onClose });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const total = parts.reduce((s, p) => s + p.quantity * p.unitPrice, 0) + Number(f.labor || 0);
  return (
    <Modal title="Repair order" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Diagnosis">{(i) => <textarea id={i} rows={2} value={f.diagnosis} onChange={set("diagnosis")} />}</Field>
        <Field label="Work performed">{(i) => <textarea id={i} rows={2} value={f.workPerformed} onChange={set("workPerformed")} />}</Field>
        <div className="grid grid-cols-[1fr_5rem_7rem_auto] items-end gap-2">
          <Field label="Part">{(i) => <input id={i} value={f.partName} onChange={set("partName")} />}</Field>
          <Field label="Qty">{(i) => <input id={i} inputMode="numeric" value={f.partQty} onChange={set("partQty")} />}</Field>
          <Field label="Unit ₹">{(i) => <input id={i} inputMode="numeric" value={f.partPrice} onChange={set("partPrice")} />}</Field>
          <Button variant="ghost" disabled={!f.partName || !f.partPrice} onClick={() => { setParts([...parts, { name: f.partName, quantity: Number(f.partQty) || 1, unitPrice: Number(f.partPrice) }]); setF({ ...f, partName: "", partQty: "1", partPrice: "" }); }}>Add</Button>
        </div>
        {parts.length > 0 && <ul className="text-sm">{parts.map((p, i) => <li key={i} className="num flex justify-between"><span>{p.quantity} × {p.name}</span><span>{inr(p.quantity * p.unitPrice)} <button className="ml-2 underline" onClick={() => setParts(parts.filter((_, j) => j !== i))}>remove</button></span></li>)}</ul>}
        <Field label="Labour (₹)">{(i) => <input id={i} inputMode="numeric" value={f.labor} onChange={(e) => setF({ ...f, labor: e.target.value.replace(/\D/g, "") })} />}</Field>
        <p className="num text-right text-lg font-bold">Total {inr(total)}</p>
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={save.isPending} disabled={!f.labor} onClick={() => save.mutate(undefined)}>Save order</Button></div>
    </Modal>
  );
}

function Row({ b, mechanics, garageId }: { b: RepairBooking; mechanics: Mechanic[]; garageId: string }) {
  const [mech, setMech] = useState("");
  const [order, setOrder] = useState(false);
  const inv = [["garage-desk", garageId]];
  const step = useAction((a: string) => post(`/bookings/${b.id}/${a}`), { ok: "Updated", invalidate: inv });
  const assign = useAction(() => post(`/bookings/${b.id}/assign-mechanic`, { mechanicId: mech }), { ok: "Mechanic assigned", invalidate: inv });
  const next: Record<string, [string, string]> = { ACCEPTED: ["", ""], MECHANIC_ASSIGNED: ["vehicle-received", "Vehicle received"], VEHICLE_RECEIVED: ["start-repair", "Start repair"], REPAIR_IN_PROGRESS: ["ready", "Mark ready for pickup"] };
  return (
    <Panel title={<span>{b.description || "Service visit"} {b.isEmergency && <Badge tone="bad">Emergency</Badge>}</span>} action={<StatusBadge status={b.status} />}>
      <p className="mb-3 text-sm text-mute">{b.scheduledAt ? `Drop-off ${dt(b.scheduledAt)}` : `Requested ${dt(b.createdAt)}`}</p>
      <div className="flex flex-wrap items-center gap-2">
        {b.status === "REQUESTED" && <Button size="sm" busy={step.isPending} onClick={() => step.mutate("accept")}>Accept</Button>}
        {b.status === "ACCEPTED" && <>
          <select aria-label="Mechanic" className="w-auto" value={mech} onChange={(e) => setMech(e.target.value)}><option value="">Choose mechanic…</option>{mechanics.filter((m) => m.isActive).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          <Button size="sm" disabled={!mech} busy={assign.isPending} onClick={() => assign.mutate(undefined)}>Assign</Button></>}
        {next[b.status]?.[0] && <Button size="sm" busy={step.isPending} onClick={() => step.mutate(next[b.status][0])}>{next[b.status][1]}</Button>}
        {["REPAIR_IN_PROGRESS", "VEHICLE_RECEIVED"].includes(b.status) && <Button size="sm" variant="ink" onClick={() => setOrder(true)}>Repair order</Button>}
      </div>
      {order && <OrderModal b={b} onClose={() => setOrder(false)} />}
    </Panel>
  );
}

export function GarageDesk() {
  const gs = useQuery({ queryKey: ["garages", "mine"], queryFn: async () => (await get<{ garages: Garage[] }>("/garages/mine")).garages });
  const g = gs.data?.[0];
  const [tab, setTab] = useState<"open" | "done">("open");
  const bookings = useQuery({ enabled: !!g, queryKey: ["garage-desk", g?.id], queryFn: async () => (await get<{ bookings: RepairBooking[] }>(`/bookings/garage/${g!.id}`)).bookings, refetchInterval: 15000 });
  const mechanics = useQuery({ enabled: !!g, queryKey: ["mechanics", g?.id], queryFn: async () => (await get<{ mechanics: Mechanic[] }>(`/garages/${g!.id}/mechanics`)).mechanics });
  if (gs.isLoading) return <Loading />;
  if (!g) return <Empty title="No garage yet">Register your garage through the API to start receiving bookings.</Empty>;
  const list = (bookings.data ?? []).filter((b) => (tab === "open" ? !["COMPLETED", "CANCELLED"].includes(b.status) : ["COMPLETED", "CANCELLED"].includes(b.status)));
  return (
    <div data-line="repair">
      <PageHeader title={g.name} sub="Incoming bookings and work in the bay." />
      <Tabs tabs={[{ id: "open", label: "In progress" }, { id: "done", label: "Finished" }]} value={tab} onChange={setTab} />
      <div className="mt-4 space-y-4">{bookings.isLoading ? <Loading /> : !list.length ? <Empty title="Nothing here" /> : list.map((b) => <Row key={b.id} b={b} mechanics={mechanics.data ?? []} garageId={g.id} />)}</div>
    </div>
  );
}

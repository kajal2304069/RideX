import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import { dt, inr, humanize } from "@/lib/format";
import { Badge, Button, Empty, Loading, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { PayModal } from "@/components/PayModal";
import { useAction } from "@/hooks/useApi";
import { RepairBooking, RepairOrder } from "./repairTypes";

function Detail({ b }: { b: RepairBooking }) {
  const q = useQuery({ queryKey: ["repair", b.id, b.status], queryFn: () => get<{ booking: RepairBooking; repairOrder: RepairOrder | null }>(`/bookings/${b.id}`) });
  const [paying, setPaying] = useState(false);
  const o = q.data?.repairOrder;
  if (!o) return null;
  return (
    <div className="mt-3 space-y-2 border-t border-rule pt-3 text-sm">
      {o.diagnosis && <p><strong>Diagnosis:</strong> {o.diagnosis}</p>}
      {o.workPerformed && <p><strong>Work done:</strong> {o.workPerformed}</p>}
      {o.partsUsed.length > 0 && <ul>{o.partsUsed.map((p, i) => <li key={i} className="num flex justify-between"><span>{p.quantity} × {p.name}</span><span>{inr(p.quantity * p.unitPrice)}</span></li>)}</ul>}
      <p className="num flex justify-between"><span>Labour</span><span>{inr(o.laborCost)}</span></p>
      <p className="num flex justify-between border-t border-rule pt-1 text-base font-bold"><span>Total</span><span>{inr(o.totalCost)}</span></p>
      {b.status === "READY" && <Button onClick={() => setPaying(true)}>Pay {inr(o.totalCost)}</Button>}
      {paying && <PayModal type="GARAGE_SERVICE" id={b.id} amount={o.totalCost} title="Pay the garage" onClose={() => setPaying(false)} onPaid={() => { setPaying(false); q.refetch(); }} />}
    </div>
  );
}

export function RepairBookings() {
  const q = useQuery({ queryKey: ["repairs", "mine"], queryFn: async () => (await get<{ bookings: RepairBooking[] }>("/bookings")).bookings, refetchInterval: 15000 });
  const cancel = useAction((id: string) => post(`/bookings/${id}/cancel`), { ok: "Booking cancelled", invalidate: [["repairs"]] });
  return (
    <div data-line="repair">
      <PageHeader title="My repairs" sub="Your garage bookings and what each one costs." />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty title="No bookings yet">Find a garage to get started.</Empty> : (
        <div className="space-y-4">{q.data.map((b) => (
          <Panel key={b.id} title={<span>{b.garage.name} {b.isEmergency && <Badge tone="bad">Emergency</Badge>}</span>} action={<StatusBadge status={b.status} />}>
            <p className="text-sm text-mute">{b.scheduledAt ? `Drop-off ${dt(b.scheduledAt)}` : `Requested ${dt(b.createdAt)}`}{b.description && ` · ${b.description}`}</p>
            <Detail b={b} />
            {["REQUESTED", "ACCEPTED"].includes(b.status) && <div className="mt-3"><Button size="sm" variant="ghost" onClick={() => cancel.mutate(b.id)}>Cancel booking</Button></div>}
          </Panel>))}</div>
      )}
      <p className="sr-only">{humanize("done")}</p>
    </div>
  );
}

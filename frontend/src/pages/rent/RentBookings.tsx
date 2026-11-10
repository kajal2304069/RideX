import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import { dt, inr } from "@/lib/format";
import { Button, Empty, Loading, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { PayModal } from "@/components/PayModal";
import { useAction } from "@/hooks/useApi";
import { Booking } from "./rentTypes";

export function RentBookings() {
  const q = useQuery({ queryKey: ["bookings", "mine"], queryFn: async () => (await get<{ bookings: Booking[] }>("/rentals/bookings/mine")).bookings, refetchInterval: 15000 });
  const [pay, setPay] = useState<Booking | null>(null);
  const cancel = useAction((id: string) => post(`/rentals/bookings/${id}/cancel`), { ok: "Booking cancelled", invalidate: [["bookings"]] });
  return (
    <div data-line="rent">
      <PageHeader title="My rentals" sub="Unpaid bookings hold the vehicle for 15 minutes, then release it." />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty title="No rentals yet">Find a vehicle and your bookings will show up here.</Empty> : (
        <Panel><ul>{q.data.map((b) => (
          <li key={b.id} className="rule-row">
            <div className="min-w-0"><p className="font-display text-base font-bold">{b.vehicleTitle}</p>
              <p className="text-sm text-mute">{dt(b.startAt)} → {dt(b.endAt)}</p>
              {b.status === "PENDING_PAYMENT" && b.paymentDueAt && <p className="text-xs text-repair-ink">Pay by {dt(b.paymentDueAt)} or the vehicle is released.</p>}
              {b.status === "COMPLETED" && <p className="text-xs text-mute">Late fee {inr(b.lateFee)} · damage {inr(b.damageDeduction)} · deposit returned {inr(b.depositRefundDue)}</p>}
              {b.status === "CANCELLED" && <p className="text-xs text-mute">Refunded {inr(b.refundAmount)}</p>}</div>
            <div className="flex items-center gap-2"><span className="num font-bold">{inr(b.totalDue)}</span><StatusBadge status={b.status} />
              {b.status === "PENDING_PAYMENT" && <Button size="sm" onClick={() => setPay(b)}>Pay</Button>}
              {["PENDING_PAYMENT", "CONFIRMED"].includes(b.status) && <Button size="sm" variant="danger" onClick={() => cancel.mutate(b.id)}>Cancel</Button>}</div>
          </li>
        ))}</ul></Panel>
      )}
      {pay && <PayModal type="RENTAL" id={pay.id} amount={pay.totalDue} title="Pay to confirm your rental" onClose={() => setPay(null)} onPaid={() => q.refetch()} />}
    </div>
  );
}

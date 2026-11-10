import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import { dt, inr } from "@/lib/format";
import { Button, Empty, Field, Loading, Modal, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { useAction } from "@/hooks/useApi";
import { Booking, RentalListing } from "../rent/rentTypes";

export function RentalDesk() {
  const listings = useQuery({ queryKey: ["rentals", "mine"], queryFn: async () => (await get<{ listings: RentalListing[] }>("/rentals/listings/mine")).listings });
  const incoming = useQuery({ queryKey: ["bookings", "incoming"], queryFn: async () => (await get<{ bookings: Booking[] }>("/rentals/bookings/incoming")).bookings, refetchInterval: 15000 });
  const [returning, setReturning] = useState<Booking | null>(null);
  const toggle = useAction((a: { id: string; on: boolean }) => post(`/rentals/listings/${a.id}/${a.on ? "activate" : "deactivate"}`), { ok: "Listing updated", invalidate: [["rentals"]] });
  const start = useAction((id: string) => post(`/rentals/bookings/${id}/start`), { ok: "Vehicle handed over", invalidate: [["bookings"], ["vehicles"]] });
  const cancel = useAction((id: string) => post(`/rentals/bookings/${id}/cancel`), { ok: "Booking cancelled; the renter is refunded", invalidate: [["bookings"]] });

  return (
    <div data-line="earn">
      <PageHeader title="Rental desk" sub="Hand vehicles over, take them back, and manage what's listed." />
      <div className="space-y-5">
        <Panel title="Bookings">
          {incoming.isLoading ? <Loading /> : !incoming.data?.length ? <Empty title="No bookings yet">When someone books one of your vehicles, it appears here.</Empty> : (
            <ul>{incoming.data.map((b) => (
              <li key={b.id} className="rule-row">
                <div><p className="font-bold">{b.vehicleTitle}</p><p className="text-sm text-mute">{dt(b.startAt)} → {dt(b.endAt)} · rent {inr(b.rentAmount)}</p></div>
                <div className="flex items-center gap-2"><StatusBadge status={b.status} />
                  {b.status === "CONFIRMED" && <Button size="sm" busy={start.isPending} onClick={() => start.mutate(b.id)}>Hand over</Button>}
                  {b.status === "CONFIRMED" && <Button size="sm" variant="danger" onClick={() => cancel.mutate(b.id)}>Cancel</Button>}
                  {b.status === "ACTIVE" && <Button size="sm" onClick={() => setReturning(b)}>Take back</Button>}</div>
              </li>
            ))}</ul>
          )}
        </Panel>
        <Panel title="Listings">
          {!listings.data?.length ? <Empty title="Nothing listed">Open "My vehicles" and choose "List for rent" on a vehicle.</Empty> : (
            <ul>{listings.data.map((l) => (
              <li key={l.id} className="rule-row">
                <div><p className="font-bold">{l.year} {l.brand} {l.model}</p><p className="num text-sm text-mute">{l.hourlyPrice != null && `${inr(l.hourlyPrice)}/h`} {l.dailyPrice != null && `· ${inr(l.dailyPrice)}/day`} · deposit {inr(l.securityDeposit)}</p></div>
                <div className="flex items-center gap-2"><StatusBadge status={l.isActive ? "ACTIVE" : "HIDDEN"} /><Button size="sm" variant="ghost" onClick={() => toggle.mutate({ id: l.id, on: !l.isActive })}>{l.isActive ? "Hide" : "Show"}</Button></div>
              </li>
            ))}</ul>
          )}
        </Panel>
      </div>
      {returning && <Return booking={returning} onClose={() => setReturning(null)} />}
    </div>
  );
}

function Return({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const [damage, setDamage] = useState("");
  const [notes, setNotes] = useState("");
  const done = useAction(() => post<{ booking: Booking }>(`/rentals/bookings/${booking.id}/complete`, { ...(damage ? { damageDeduction: Number(damage) } : {}), ...(notes ? { notes } : {}) }),
    { ok: "Vehicle returned. Earnings recorded and the deposit refunded.", invalidate: [["bookings"], ["vehicles"], ["earnings"]], onDone: onClose });
  return (
    <Modal title={`Take back ${booking.vehicleTitle}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-mute">Any late fee is worked out from the real return time. Late fees and damage claims come out of the {inr(booking.depositAmount)} deposit; the rest goes back to the renter.</p>
        <Field label="Damage claim (₹)" hint="Leave empty if there is none. Can't exceed the deposit.">{(id) => <input id={id} type="number" min={0} max={booking.depositAmount} value={damage} onChange={(e) => setDamage(e.target.value)} />}</Field>
        <Field label="Notes">{(id) => <textarea id={id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={done.isPending} onClick={() => done.mutate(undefined)}>Confirm return</Button></div>
      </div>
    </Modal>
  );
}

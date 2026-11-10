import { FormEvent, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, patch, post } from "@/lib/api";
import { Button, Empty, Field, Loading, Modal, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { useAction, useVehicleTypes } from "@/hooks/useApi";
import { CITY_CENTER } from "@/components/MapView";
import { humanize } from "@/lib/format";

export interface Vehicle {
  id: string; vehicleTypeId: string; registrationNumber: string; brand: string; model: string; year: number; color: string | null;
  fuelType: string; transmission: string; mileageKm: number; status: string; currentDriverId: string | null;
}
const SETTABLE = ["AVAILABLE", "UNAVAILABLE", "UNDER_MAINTENANCE"];

export function Vehicles() {
  const q = useQuery({ queryKey: ["vehicles"], queryFn: async () => (await get<{ vehicles: Vehicle[] }>("/vehicles/mine")).vehicles });
  const [adding, setAdding] = useState(false);
  const [assign, setAssign] = useState<Vehicle | null>(null);
  const [rent, setRent] = useState<Vehicle | null>(null);
  const setStatus = useAction((a: { id: string; status: string }) => patch(`/vehicles/${a.id}/status`, { status: a.status }), { ok: "Status updated", invalidate: [["vehicles"]] });
  const unassign = useAction((id: string) => post(`/vehicles/${id}/unassign-driver`), { ok: "Driver unassigned", invalidate: [["vehicles"]] });

  return (
    <div data-line="earn">
      <PageHeader title="My vehicles" sub="Put a vehicle to work: assign it to a driver for ride earnings, or list it for rent." action={<Button onClick={() => setAdding(true)}>Add a vehicle</Button>} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty title="No vehicles yet">Add your first vehicle to start earning from it.</Empty> : (
        <Panel>
          <ul>{q.data.map((v) => (
            <li key={v.id} className="rule-row">
              <div className="min-w-0">
                <p className="font-display text-base font-bold">{v.year} {v.brand} {v.model}</p>
                <p className="text-sm text-mute">{v.registrationNumber} · {humanize(v.fuelType)} · {humanize(v.transmission)}{v.currentDriverId ? " · driver assigned" : ""}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={v.status} />
                {SETTABLE.includes(v.status) && (
                  <select aria-label="Change status" className="!w-auto !py-1 text-xs" value={v.status} onChange={(e) => setStatus.mutate({ id: v.id, status: e.target.value })}>
                    {SETTABLE.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                  </select>
                )}
                {v.currentDriverId
                  ? <Button size="sm" variant="ghost" onClick={() => unassign.mutate(v.id)}>Unassign driver</Button>
                  : <Button size="sm" variant="ghost" disabled={v.status !== "AVAILABLE"} onClick={() => setAssign(v)}>Assign driver</Button>}
                <Button size="sm" variant="ghost" onClick={() => setRent(v)}>List for rent</Button>
              </div>
            </li>
          ))}</ul>
        </Panel>
      )}
      {adding && <AddVehicle onClose={() => setAdding(false)} />}
      {assign && <AssignDriver vehicle={assign} onClose={() => setAssign(null)} />}
      {rent && <ListForRent vehicle={rent} onClose={() => setRent(null)} />}
    </div>
  );
}

function AddVehicle({ onClose }: { onClose: () => void }) {
  const types = useVehicleTypes();
  const add = useAction((b: object) => post("/vehicles", b), { ok: "Vehicle added", invalidate: [["vehicles"]], onDone: onClose });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    add.mutate({
      vehicleTypeId: f.get("type"), registrationNumber: f.get("reg"), brand: f.get("brand"), model: f.get("model"), year: Number(f.get("year")),
      color: f.get("color") || undefined, fuelType: f.get("fuel"), transmission: f.get("trans"), mileageKm: Number(f.get("km") || 0),
    });
  }
  return (
    <Modal title="Add a vehicle" onClose={onClose}>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Type">{(id) => <select id={id} name="type" required>{(types.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}</Field>
        <Field label="Registration number">{(id) => <input id={id} name="reg" required minLength={4} />}</Field>
        <Field label="Brand">{(id) => <input id={id} name="brand" required />}</Field>
        <Field label="Model">{(id) => <input id={id} name="model" required />}</Field>
        <Field label="Year">{(id) => <input id={id} name="year" type="number" min={1980} max={new Date().getFullYear() + 1} defaultValue={new Date().getFullYear() - 2} required />}</Field>
        <Field label="Colour">{(id) => <input id={id} name="color" />}</Field>
        <Field label="Fuel">{(id) => <select id={id} name="fuel">{["PETROL", "DIESEL", "ELECTRIC", "HYBRID", "CNG"].map((f) => <option key={f} value={f}>{humanize(f)}</option>)}</select>}</Field>
        <Field label="Transmission">{(id) => <select id={id} name="trans"><option>MANUAL</option><option>AUTOMATIC</option></select>}</Field>
        <Field label="Odometer (km)">{(id) => <input id={id} name="km" type="number" min={0} defaultValue={0} />}</Field>
        <div className="flex items-end justify-end gap-2 sm:col-span-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" busy={add.isPending}>Add vehicle</Button></div>
      </form>
    </Modal>
  );
}

function AssignDriver({ vehicle, onClose }: { vehicle: Vehicle; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [driver, setDriver] = useState<{ id: string; fullName: string } | null | undefined>(undefined);
  const [platform, setPlatform] = useState(20);
  const [ownerShare, setOwnerShare] = useState(80);
  const look = useAction(async () => (await get<{ driver: { id: string; fullName: string } | null }>("/vehicles/drivers/lookup", { email })).driver, { onDone: (d) => setDriver(d) });
  const assign = useAction(() => post(`/vehicles/${vehicle.id}/assign-driver`, { driverId: driver!.id, commissionPercent: platform, ownerSharePercent: ownerShare }),
    { ok: "Driver assigned", invalidate: [["vehicles"]], onDone: onClose });
  const driverShare = Math.round((100 - ownerShare) * (100 - platform)) / 100;
  const ownerPct = Math.round(ownerShare * (100 - platform)) / 100;
  return (
    <Modal title={`Assign a driver to ${vehicle.brand} ${vehicle.model}`} onClose={onClose}>
      <div className="space-y-4">
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); look.mutate(undefined); }}>
          <div className="flex-1"><Field label="Driver's email" hint="They must be a verified driver without a vehicle.">{(id) => <input id={id} type="email" value={email} onChange={(e) => { setEmail(e.target.value); setDriver(undefined); }} required />}</Field></div>
          <Button type="submit" variant="ink" busy={look.isPending}>Find</Button>
        </form>
        {driver === null && <p className="rounded-2xl bg-repair/10 px-4 py-3 font-semibold text-sm">No available verified driver with that email.</p>}
        {driver && (
          <>
            <p className="rounded-2xl bg-earn/10 px-4 py-3 font-semibold text-sm">Found <strong>{driver.fullName}</strong>.</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Platform commission (%)">{(id) => <input id={id} type="number" min={0} max={100} value={platform} onChange={(e) => setPlatform(Number(e.target.value))} />}</Field>
              <Field label="Your share of the rest (%)">{(id) => <input id={id} type="number" min={0} max={100} value={ownerShare} onChange={(e) => setOwnerShare(Number(e.target.value))} />}</Field>
            </div>
            <p className="text-sm text-mute">Of every fare: RideX keeps {platform}%, you earn {ownerPct}%, the driver earns {driverShare}%.</p>
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={assign.isPending} onClick={() => assign.mutate(undefined)}>Assign driver</Button></div>
          </>
        )}
      </div>
    </Modal>
  );
}

function ListForRent({ vehicle, onClose }: { vehicle: Vehicle; onClose: () => void }) {
  const create = useAction((b: object) => post("/rentals/listings", b), { ok: "Listed for rent", invalidate: [["rentals", "mine"]], onDone: onClose });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => (f.get(k) ? Number(f.get(k)) : undefined);
    create.mutate({ vehicleId: vehicle.id, hourlyPrice: num("hourly"), dailyPrice: num("daily"), securityDeposit: num("deposit") ?? 0, lat: Number(f.get("lat")), lng: Number(f.get("lng")), address: f.get("address") || undefined, rules: f.get("rules") || undefined });
  }
  return (
    <Modal title={`Rent out ${vehicle.brand} ${vehicle.model}`} onClose={onClose}>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Price per hour (₹)">{(id) => <input id={id} name="hourly" type="number" min={1} step="any" />}</Field>
        <Field label="Price per day (₹)">{(id) => <input id={id} name="daily" type="number" min={1} step="any" />}</Field>
        <Field label="Security deposit (₹)">{(id) => <input id={id} name="deposit" type="number" min={0} defaultValue={2000} />}</Field>
        <Field label="Pickup address">{(id) => <input id={id} name="address" />}</Field>
        <Field label="Latitude">{(id) => <input id={id} name="lat" type="number" step="any" defaultValue={CITY_CENTER.lat} required />}</Field>
        <Field label="Longitude">{(id) => <input id={id} name="lng" type="number" step="any" defaultValue={CITY_CENTER.lng} required />}</Field>
        <div className="sm:col-span-2"><Field label="Rules">{(id) => <textarea id={id} name="rules" rows={2} />}</Field></div>
        <p className="text-xs text-mute sm:col-span-2">Set an hourly price, a daily price, or both.</p>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" busy={create.isPending}>List for rent</Button></div>
      </form>
    </Modal>
  );
}

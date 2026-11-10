import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import { dt, inr, humanize } from "@/lib/format";
import { Button, Empty, Field, Loading, Modal, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { MapView } from "@/components/MapView";
import { useAction, useMyLocation, useVehicleTypes } from "@/hooks/useApi";
import { Listing, Offer, CONDITIONS, FUELS, TRANSMISSIONS } from "./marketTypes";

function Offers({ listing }: { listing: Listing }) {
  const q = useQuery({ queryKey: ["offers", "listing", listing.id], queryFn: async () => (await get<{ offers: Offer[] }>(`/marketplace/listings/${listing.id}/offers`)).offers });
  const inv = [["offers"], ["listings", "mine"], ["listing", listing.id]];
  const accept = useAction((id: string) => post(`/marketplace/offers/${id}/accept`), { ok: "Offer accepted. The vehicle is reserved for this buyer.", invalidate: inv });
  const reject = useAction((id: string) => post(`/marketplace/offers/${id}/reject`), { ok: "Offer rejected", invalidate: inv });
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <p className="text-sm text-mute">No offers yet.</p>;
  return (
    <ul className="divide-y divide-rule border border-rule">
      {q.data.map((o) => (
        <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
          <div><p className="num font-bold">{inr(o.amount)}</p><p className="text-xs text-mute">{o.buyer?.name ?? "Buyer"} · {dt(o.createdAt)}</p></div>
          <div className="flex items-center gap-2">
            <StatusBadge status={o.status} />
            {o.status === "PENDING" && !listing.isReserved && <>
              <Button size="sm" busy={accept.isPending} onClick={() => accept.mutate(o.id)}>Accept</Button>
              <Button size="sm" variant="ghost" onClick={() => reject.mutate(o.id)}>Reject</Button>
            </>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function NewListing({ onClose }: { onClose: () => void }) {
  const types = useVehicleTypes();
  const { pos } = useMyLocation();
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [f, setF] = useState({ vehicleTypeId: "", brand: "", model: "", year: String(new Date().getFullYear() - 3), mileageKm: "", fuelType: "PETROL", transmission: "MANUAL", condition: "GOOD", ownerCount: "1", price: "", address: "", description: "", insuranceValidUntil: "", image: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const where = pin ?? pos;
  const ok = f.vehicleTypeId && f.brand && f.model && f.price && f.mileageKm;
  const create = useAction(async () => {
    const r = await post<{ listing: Listing }>("/marketplace/listings", {
      vehicleTypeId: f.vehicleTypeId, brand: f.brand.trim(), model: f.model.trim(), year: Number(f.year), mileageKm: Number(f.mileageKm),
      fuelType: f.fuelType, transmission: f.transmission, condition: f.condition, ownerCount: Number(f.ownerCount), price: Number(f.price),
      lat: where.lat, lng: where.lng, address: f.address || undefined, description: f.description || undefined, insuranceValidUntil: f.insuranceValidUntil || undefined,
    });
    if (f.image.startsWith("https://")) await post(`/marketplace/listings/${r.listing.id}/images`, { url: f.image, position: 0 });
    return r;
  }, { ok: "Listing published", invalidate: [["listings", "mine"]], onDone: onClose });
  const sel = (k: keyof typeof f, list: string[]) => (i: string) => <select id={i} value={f[k]} onChange={set(k)}>{list.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</select>;
  return (
    <Modal title="List a vehicle for sale" onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vehicle type">{(i) => <select id={i} value={f.vehicleTypeId} onChange={set("vehicleTypeId")}><option value="">Choose…</option>{(types.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}</Field>
        <Field label="Asking price (₹)">{(i) => <input id={i} inputMode="numeric" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value.replace(/\D/g, "") })} />}</Field>
        <Field label="Brand">{(i) => <input id={i} value={f.brand} onChange={set("brand")} />}</Field>
        <Field label="Model">{(i) => <input id={i} value={f.model} onChange={set("model")} />}</Field>
        <Field label="Year">{(i) => <input id={i} inputMode="numeric" value={f.year} onChange={set("year")} />}</Field>
        <Field label="Odometer (km)">{(i) => <input id={i} inputMode="numeric" value={f.mileageKm} onChange={(e) => setF({ ...f, mileageKm: e.target.value.replace(/\D/g, "") })} />}</Field>
        <Field label="Fuel">{sel("fuelType", FUELS)}</Field>
        <Field label="Gearbox">{sel("transmission", TRANSMISSIONS)}</Field>
        <Field label="Condition">{sel("condition", CONDITIONS)}</Field>
        <Field label="Previous owners">{(i) => <input id={i} inputMode="numeric" value={f.ownerCount} onChange={set("ownerCount")} />}</Field>
        <Field label="Insurance valid until">{(i) => <input id={i} type="date" value={f.insuranceValidUntil} onChange={set("insuranceValidUntil")} />}</Field>
        <Field label="Photo URL (https)">{(i) => <input id={i} value={f.image} onChange={set("image")} placeholder="https://…" />}</Field>
      </div>
      <div className="mt-3 space-y-3">
        <Field label="Address">{(i) => <input id={i} value={f.address} onChange={set("address")} />}</Field>
        <Field label="Description">{(i) => <textarea id={i} rows={3} value={f.description} onChange={set("description")} />}</Field>
        <div><p className="mb-1 text-sm font-semibold">Where is it? Click the map to move the pin.</p><MapView height={200} fit={false} center={where} onPick={setPin} markers={[{ ...where, icon: "listing" }]} /></div>
      </div>
      <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!ok} busy={create.isPending} onClick={() => create.mutate(undefined)}>Publish listing</Button></div>
    </Modal>
  );
}

export function Sell() {
  const q = useQuery({ queryKey: ["listings", "mine"], queryFn: async () => (await get<{ listings: Listing[] }>("/marketplace/listings/mine")).listings });
  const [open, setOpen] = useState(false);
  const [showOffers, setShowOffers] = useState<string | null>(null);
  const delist = useAction((id: string) => post(`/marketplace/listings/${id}/delist`), { ok: "Listing hidden", invalidate: [["listings", "mine"]] });
  const relist = useAction((id: string) => post(`/marketplace/listings/${id}/relist`), { ok: "Listing live again", invalidate: [["listings", "mine"]] });
  return (
    <div data-line="market">
      <PageHeader title="Sell a vehicle" sub="Your listings, and the offers buyers have made on them." action={<Button onClick={() => setOpen(true)}>New listing</Button>} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty title="You haven't listed anything">Add a vehicle and buyers nearby will see it.</Empty> : (
        <div className="space-y-4">
          {q.data.map((l) => (
            <Panel key={l.id} title={<Link to={`/buy/listings/${l.id}`} className="underline">{l.year} {l.brand} {l.model}</Link>} action={<StatusBadge status={l.status} />}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="num"><strong>{inr(l.price)}</strong> <span className="text-sm text-mute">· {l.mileageKm.toLocaleString("en-IN")} km{l.isReserved && " · reserved"}</span></p>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setShowOffers(showOffers === l.id ? null : l.id)}>{showOffers === l.id ? "Hide offers" : "Offers"}</Button>
                  {l.status === "ACTIVE" ? <Button size="sm" variant="ghost" onClick={() => delist.mutate(l.id)}>Hide</Button> : l.status === "DELISTED" ? <Button size="sm" onClick={() => relist.mutate(l.id)}>Relist</Button> : null}
                </div>
              </div>
              {showOffers === l.id && <div className="mt-3"><Offers listing={l} /></div>}
            </Panel>
          ))}
        </div>
      )}
      {open && <NewListing onClose={() => setOpen(false)} />}
    </div>
  );
}

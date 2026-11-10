import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get, post, put, del } from "@/lib/api";
import { dateOnly, inr, humanize, km, toLocalInput } from "@/lib/format";
import { Badge, Button, ErrorNote, Field, Loading, PageHeader, Panel, Stat } from "@/components/ui";
import { MapView } from "@/components/MapView";
import { useAction } from "@/hooks/useApi";
import { useAuth } from "@/store/auth";
import { Listing } from "./marketTypes";

export function MarketDetail() {
  const { id } = useParams();
  const user = useAuth((s) => s.user);
  const q = useQuery({ queryKey: ["listing", id], queryFn: async () => (await get<{ listing: Listing }>(`/marketplace/listings/${id}`)).listing });
  const [amount, setAmount] = useState("");
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 48 * 3600_000)));
  const [fav, setFav] = useState<boolean | null>(null);
  const offer = useAction(() => post(`/marketplace/listings/${id}/offers`, { amount: Number(amount) }), { ok: "Offer sent to the seller", invalidate: [["offers"]], onDone: () => setAmount("") });
  const inspect = useAction(() => post(`/marketplace/listings/${id}/inspections`, { scheduledAt: new Date(when).toISOString() }), { ok: "Inspection requested. A mechanic will pick it up.", invalidate: [["inspections"]] });
  const favorite = useAction((on: boolean) => (on ? put(`/marketplace/listings/${id}/favorite`) : del(`/marketplace/listings/${id}/favorite`)), { invalidate: [["favorites"]], onDone: () => undefined });

  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorNote error={q.error ?? new Error("Listing not found")} />;
  const l = q.data;
  const mine = user?.id === l.seller.id;
  const isFav = fav ?? !!l.isFavorite;
  const amt = Number(amount);

  return (
    <div data-line="market">
      <PageHeader title={`${l.year} ${l.brand} ${l.model}`} sub={`Sold by ${l.seller.name}${l.address ? ` · ${l.address}` : ""}`}
        action={!mine && user && <Button variant="ghost" onClick={() => { const next = !isFav; setFav(next); favorite.mutate(next); }}>{isFav ? "★ Saved" : "☆ Save"}</Button>} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          {(l.images?.length ? l.images.map((i) => i.url) : l.thumbnail ? [l.thumbnail] : []).slice(0, 3).map((u) => <img key={u} src={u} alt="" className="max-h-96 w-full border border-rule object-cover" />)}
          <Panel><div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Price" value={inr(l.price)} /><Stat label="Odometer" value={`${l.mileageKm.toLocaleString("en-IN")} km`} />
            <Stat label="Owners" value={l.ownerCount} /><Stat label="Condition" value={humanize(l.condition)} />
            <Stat label="Fuel" value={humanize(l.fuelType)} /><Stat label="Gearbox" value={humanize(l.transmission)} />
            <Stat label="Insurance until" value={l.insuranceValidUntil ? dateOnly(l.insuranceValidUntil) : "Not stated"} />
            <Stat label="Status" value={<Badge tone={l.status === "ACTIVE" ? "good" : "warn"}>{humanize(l.status)}</Badge>} />
          </div></Panel>
          {l.description && <Panel title="About this vehicle"><p className="whitespace-pre-line">{l.description}</p></Panel>}
          <Panel title="Where it is"><MapView height={260} markers={[{ lat: l.location.lat, lng: l.location.lng, icon: "listing" }]} />{l.distanceMeters != null && <p className="mt-2 text-sm text-mute">{km(l.distanceMeters)} from you</p>}</Panel>
        </div>
        <div className="space-y-5 lg:sticky lg:top-4 lg:self-start">
          {mine ? <Panel title="Your listing"><p>Manage offers and details from the Sell page.</p></Panel> : !user ? <Panel><p>Sign in to make an offer.</p></Panel> : l.status !== "ACTIVE" ? <Panel><p>This vehicle is no longer available.</p></Panel> : (<>
            <Panel title="Make an offer">
              {l.isReserved && <p className="mb-3 rounded-2xl bg-market/10 px-4 py-3 font-semibold text-sm">An offer has been accepted. Offers are closed unless it falls through.</p>}
              <Field label="Your offer (₹)" hint={`Asking ${inr(l.price)}`}>{(i) => <input id={i} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} />}</Field>
              <Button className="mt-3 w-full" disabled={!amt || l.isReserved} busy={offer.isPending} onClick={() => offer.mutate(undefined)}>Send offer</Button>
            </Panel>
            <Panel title="Book an inspection">
              <p className="mb-3 text-sm text-mute">A verified mechanic checks the engine, brakes, tyres and papers, and you get a scored report.</p>
              <Field label="When">{(i) => <input id={i} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}</Field>
              <Button variant="ink" className="mt-3 w-full" busy={inspect.isPending} onClick={() => inspect.mutate(undefined)}>Request inspection</Button>
            </Panel>
          </>)}
        </div>
      </div>
    </div>
  );
}

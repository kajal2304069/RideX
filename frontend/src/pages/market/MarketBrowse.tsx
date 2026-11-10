import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/api";
import { inr, km, humanize } from "@/lib/format";
import { Badge, Empty, ErrorNote, Field, Loading, PageHeader } from "@/components/ui";
import { useMyLocation, useVehicleTypes } from "@/hooks/useApi";
import { Listing, FUELS, CONDITIONS } from "./marketTypes";

export function MarketBrowse() {
  const { pos } = useMyLocation();
  const types = useVehicleTypes();
  const [f, setF] = useState({ q: "", vehicleTypeId: "", fuelType: "", condition: "", maxPrice: "", sort: "newest" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const q = useQuery({
    queryKey: ["market", f, pos.lat.toFixed(2)],
    queryFn: async () => (await get<{ listings: Listing[] }>("/marketplace/listings", {
      q: f.q || undefined, vehicleTypeId: f.vehicleTypeId || undefined, fuelType: f.fuelType || undefined, condition: f.condition || undefined,
      maxPrice: f.maxPrice || undefined, sort: f.sort, lat: pos.lat, lng: pos.lng, radiusMeters: 100000,
    })).listings,
  });
  return (
    <div data-line="market">
      <PageHeader title="Buy a vehicle" sub="Second-hand cars and bikes from sellers near you. Make an offer or book an inspection." />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-6">
        <div className="col-span-2 lg:col-span-1"><Field label="Search">{(i) => <input id={i} placeholder="Brand or model" value={f.q} onChange={set("q")} />}</Field></div>
        <Field label="Type">{(i) => <select id={i} value={f.vehicleTypeId} onChange={set("vehicleTypeId")}><option value="">Any</option>{(types.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}</Field>
        <Field label="Fuel">{(i) => <select id={i} value={f.fuelType} onChange={set("fuelType")}><option value="">Any</option>{FUELS.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</select>}</Field>
        <Field label="Condition">{(i) => <select id={i} value={f.condition} onChange={set("condition")}><option value="">Any</option>{CONDITIONS.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</select>}</Field>
        <Field label="Max price (₹)">{(i) => <input id={i} inputMode="numeric" value={f.maxPrice} onChange={set("maxPrice")} />}</Field>
        <Field label="Sort">{(i) => <select id={i} value={f.sort} onChange={set("sort")}><option value="newest">Newest</option><option value="price_asc">Price, low to high</option><option value="price_desc">Price, high to low</option><option value="distance">Nearest</option></select>}</Field>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : !q.data?.length ? <Empty title="Nothing matches">Loosen a filter or two.</Empty> : (
        <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {q.data.map((l) => (
            <li key={l.id} className="panel overflow-hidden">
              <Link to={`/buy/listings/${l.id}`} className="block">
                {l.thumbnail ? <img src={l.thumbnail} alt="" loading="lazy" className="h-44 w-full object-cover" /> : <div className="h-44 bg-rule" />}
                <div className="space-y-1 p-4">
                  <p className="font-display text-lg font-bold">{l.year} {l.brand} {l.model}</p>
                  <p className="num text-xl font-bold text-market-ink">{inr(l.price)}</p>
                  <p className="text-sm text-mute">{l.mileageKm.toLocaleString("en-IN")} km · {humanize(l.fuelType)} · {humanize(l.transmission)}</p>
                  <p className="flex flex-wrap items-center gap-2 text-sm text-mute"><Badge>{humanize(l.condition)}</Badge>{l.isReserved && <Badge tone="warn">Reserved</Badge>}{l.distanceMeters != null && <span>{km(l.distanceMeters)} away</span>}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

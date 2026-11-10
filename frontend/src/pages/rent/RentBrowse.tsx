import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/api";
import { inr, km, humanize } from "@/lib/format";
import { Empty, Loading, PageHeader, Field } from "@/components/ui";
import { MapView } from "@/components/MapView";
import { useMyLocation, useVehicleTypes } from "@/hooks/useApi";
import { RentalListing } from "./rentTypes";

export function RentBrowse() {
  const { pos } = useMyLocation();
  const types = useVehicleTypes();
  const [typeId, setTypeId] = useState("");
  const [sort, setSort] = useState("newest");
  const q = useQuery({
    queryKey: ["rentals", typeId, sort, pos.lat.toFixed(2)],
    queryFn: async () => (await get<{ listings: RentalListing[] }>("/rentals/listings", { vehicleTypeId: typeId || undefined, sort, lat: pos.lat, lng: pos.lng, radiusMeters: 50000 })).listings,
  });
  return (
    <div data-line="rent">
      <PageHeader title="Rent a vehicle" sub="Bikes, cars and more from owners near you, by the hour or the day." />
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_1fr_2fr]">
        <Field label="Vehicle type">{(id) => <select id={id} value={typeId} onChange={(e) => setTypeId(e.target.value)}><option value="">Any type</option>{(types.data ?? []).filter((t) => t.category !== "RIDE").map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}</Field>
        <Field label="Sort by">{(id) => <select id={id} value={sort} onChange={(e) => setSort(e.target.value)}><option value="newest">Newest</option><option value="price_asc">Lowest daily price</option><option value="distance">Nearest</option></select>}</Field>
      </div>
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty title="No vehicles match">Try a different type, or check back soon.</Empty> : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
          <ul className="border border-rule bg-white">
            {q.data.map((l) => (
              <li key={l.id} className="border-b border-rule last:border-b-0">
                <Link to={`/rent/listings/${l.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 hover:bg-rent/5">
                  <div>
                    <p className="font-display text-lg font-bold">{l.year} {l.brand} {l.model}</p>
                    <p className="text-sm text-mute">{humanize(l.fuelType)} · {humanize(l.transmission)} · {l.location.address ?? "Pickup location on map"}{l.distanceMeters != null && ` · ${km(l.distanceMeters)} away`}</p>
                  </div>
                  <div className="num text-right">
                    {l.hourlyPrice != null && <p><strong>{inr(l.hourlyPrice)}</strong> <span className="text-sm text-mute">/ hour</span></p>}
                    {l.dailyPrice != null && <p><strong>{inr(l.dailyPrice)}</strong> <span className="text-sm text-mute">/ day</span></p>}
                    <p className="text-xs text-mute">{inr(l.securityDeposit)} refundable deposit</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="lg:sticky lg:top-4 lg:self-start"><MapView height={420} markers={q.data.map((l) => ({ lat: l.location.lat, lng: l.location.lng, icon: "car" as const, popup: `${l.brand} ${l.model}` }))} /></div>
        </div>
      )}
    </div>
  );
}

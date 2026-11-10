import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import { humanize, inr, newKey, toLocalInput } from "@/lib/format";
import { Button, ErrorNote, Field, Loading, PageHeader, Panel } from "@/components/ui";
import { MapView } from "@/components/MapView";
import { useAction } from "@/hooks/useApi";
import { Garage, GarageService, RepairBooking } from "./repairTypes";

export function GarageDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["garage", id], queryFn: () => get<{ garage: Garage; services: GarageService[] }>(`/garages/${id}`) });
  const [service, setService] = useState("");
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 24 * 3600_000)));
  const [note, setNote] = useState("");
  const [key] = useState(newKey);
  const book = useAction(() => post<{ booking: RepairBooking }>("/bookings", { garageId: id, garageServiceId: service || undefined, scheduledAt: new Date(when).toISOString(), description: note || undefined, idempotencyKey: key }), { ok: "Booking requested", onDone: () => nav("/repair/bookings") });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorNote error={q.error ?? new Error("Garage not found")} />;
  const { garage: g, services } = q.data;
  return (
    <div data-line="repair">
      <PageHeader title={g.name} sub={[g.address, g.phone].filter(Boolean).join(" · ")} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-5">
          <Panel title="Services">
            <ul className="divide-y divide-rule">{services.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2"><span>{humanize(s.serviceType)} <span className="text-xs text-mute">· about {s.estimatedDurationMinutes} min</span></span><span className="num">{inr(s.priceFrom)} – {inr(s.priceTo)}</span></li>))}</ul>
            <p className="mt-3 text-xs text-mute">The final price is set by the garage after diagnosis. You pay when the work is done.</p>
          </Panel>
          {g.openingHours && <Panel title="Opening hours"><dl className="grid grid-cols-[4rem_1fr] gap-y-1 text-sm">{["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => <div key={d} className="contents"><dt className="font-semibold uppercase">{d}</dt><dd className="num">{g.openingHours?.[d] ?? "Closed"}</dd></div>)}</dl></Panel>}
          <MapView height={240} markers={[{ ...g.location, icon: "garage", popup: g.name }]} />
        </div>
        <Panel title="Book a visit" className="lg:sticky lg:top-4 lg:self-start">
          <div className="space-y-3">
            <Field label="Service">{(i) => <select id={i} value={service} onChange={(e) => setService(e.target.value)}><option value="">Not sure, diagnose it</option>{services.map((s) => <option key={s.id} value={s.id}>{humanize(s.serviceType)}</option>)}</select>}</Field>
            <Field label="Drop-off time">{(i) => <input id={i} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}</Field>
            <Field label="What's wrong?">{(i) => <textarea id={i} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <Button className="w-full" busy={book.isPending} onClick={() => book.mutate(undefined)}>Request booking</Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

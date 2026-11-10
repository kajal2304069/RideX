import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import { humanize, km, newKey } from "@/lib/format";
import { Button, Empty, Field, Loading, Modal, PageHeader } from "@/components/ui";
import { MapView } from "@/components/MapView";
import { useAction, useMyLocation } from "@/hooks/useApi";
import { useLiveLocation } from "@/hooks/useLiveLocation";
import { LocationStatus } from "@/components/LocationStatus";
import { directionsUrl } from "@/lib/maps";
import { Navigation } from "lucide-react";
import { Garage, RepairBooking } from "./repairTypes";

function Emergency({ pos, onClose }: { pos: { lat: number; lng: number }; onClose: () => void }) {
  const nav = useNavigate();
  const [text, setText] = useState("");
  const [key] = useState(newKey);
  const send = useAction(() => post<{ booking: RepairBooking }>("/bookings/emergency", { lat: pos.lat, lng: pos.lng, description: text || undefined, idempotencyKey: key }), { ok: "Help requested. The nearest garage has been notified.", onDone: () => nav("/repair/bookings") });
  return (
    <Modal title="Roadside emergency" onClose={onClose}>
      <p className="mb-3">We'll send your current location to the closest open garage that offers emergency repair.</p>
      <Field label="What happened?">{(i) => <textarea id={i} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Flat tyre, engine won't start…" />}</Field>
      <div className="mt-4 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" busy={send.isPending} onClick={() => send.mutate(undefined)}>Send for help</Button></div>
    </Modal>
  );
}

export function Garages() {
  const fallback = useMyLocation();
  const live = useLiveLocation();
  const pos = live.pos ? { lat: live.pos.lat, lng: live.pos.lng } : fallback.pos;
  const [sos, setSos] = useState(false);
  const q = useQuery({ queryKey: ["garages", pos.lat.toFixed(2), pos.lng.toFixed(2)], queryFn: async () => (await get<{ garages: Garage[] }>("/garages/nearby", { lat: pos.lat, lng: pos.lng, radiusMeters: 30000 })).garages });
  return (
    <div data-line="repair">
      <PageHeader title="Find a garage" sub="Servicing, repairs and roadside help from garages near you." action={<Button variant="danger" onClick={() => setSos(true)}>Breakdown? Get help</Button>} />
      <div className="mb-4"><LocationStatus status={live.status} error={live.error} accuracy={live.pos?.accuracy} retry={live.retry} /></div>
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty title="No garages nearby">Try again from a different location.</Empty> : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
          <ul className="overflow-hidden rounded-3xl bg-white shadow-card">
            {q.data.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-3 border-b border-rule px-4 py-4 last:border-b-0 hover:bg-repair/5">
                <Link to={`/repair/garages/${g.id}`} className="min-w-0 flex-1">
                  <p className="font-display text-lg font-bold">{g.name}</p>
                  <p className="text-sm text-mute">{g.address ?? "Address on map"}{g.distanceMeters != null && ` · ${km(g.distanceMeters)} away`}</p>
                  <p className="mt-1 text-xs text-mute">{(g.serviceTypes ?? []).slice(0, 4).map(humanize).join(" · ")}</p>
                </Link>
                <div className="num text-right text-sm">{g.ratingAvg != null && <p><strong>★ {Number(g.ratingAvg).toFixed(1)}</strong></p>}{g.priceRange && <p className="text-mute">{g.priceRange}</p>}</div>
                <a className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer noopener" href={directionsUrl(g.location, pos)}><Navigation size={14} aria-hidden />Directions</a>
              </li>
            ))}
          </ul>
          <div className="lg:sticky lg:top-4 lg:self-start"><MapView height={420} markers={[{ ...pos, icon: "me", popup: "You are here" }, ...q.data.map((g) => ({ ...g.location, icon: "garage" as const, popup: g.name }))]} /></div>
        </div>
      )}
      {sos && <Emergency pos={pos} onClose={() => setSos(false)} />}
    </div>
  );
}

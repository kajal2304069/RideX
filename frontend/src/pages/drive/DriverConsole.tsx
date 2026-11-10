import { FormEvent, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import { connectSocket } from "@/lib/socket";
import { dt, inr, km, humanize } from "@/lib/format";
import { Badge, Button, Empty, Field, Loading, PageHeader, Panel, Stat, StatusBadge } from "@/components/ui";
import { CITY_CENTER, MapPoint, MapView } from "@/components/MapView";
import { useAction } from "@/hooks/useApi";
import { useLiveLocation } from "@/hooks/useLiveLocation";
import { LocationStatus } from "@/components/LocationStatus";
import { directionsUrl, distanceM } from "@/lib/maps";
import { Link } from "react-router-dom";
import { Check, MapPin, MessageCircle, Navigation, Phone, Star, Wrench } from "lucide-react";
import { RideChat } from "@/components/RideChat";
import { cn } from "@/lib/format";
import { Garage } from "../repair/repairTypes";
import { Ride } from "../ride/rideTypes";

interface Driver { userId: string; verificationStatus: string; isOnline: boolean; currentVehicleId: string | null; ratingAvg: number; totalRides: number; licenseNumber: string }
type Pt = { lat: number; lng: number };

const NEXT: Record<string, { action: string; label: string } | undefined> = {
  DRIVER_ASSIGNED: { action: "arriving", label: "Head to pickup" },
  DRIVER_ARRIVING: { action: "arrived", label: "I've arrived" },
  DRIVER_ARRIVED: { action: "start", label: "Start trip" },
  TRIP_STARTED: { action: "complete", label: "Complete trip" },
};

export function DriverConsole() {
  const profile = useQuery({
    queryKey: ["driver", "me"],
    queryFn: async () => { try { return (await get<{ driver: Driver }>("/drivers/me")).driver; } catch { return null; } },
  });
  if (profile.isLoading) return <Loading />;
  return (
    <div data-line="earn">
      <PageHeader title="Driver console" sub="Go online, accept rides and run your trips." />
      {!profile.data ? <Onboard /> : <Console driver={profile.data} />}
    </div>
  );
}

function Onboard() {
  const [num, setNum] = useState("");
  const [exp, setExp] = useState("");
  const onboard = useAction(() => post("/drivers/onboard", { licenseNumber: num, licenseExpiry: exp }), { ok: "Submitted for verification", invalidate: [["driver"]] });
  return (
    <Panel title="Become a driver" className="max-w-lg">
      <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); onboard.mutate(undefined); }}>
        <Field label="Driving licence number">{(id) => <input id={id} value={num} onChange={(e) => setNum(e.target.value)} required minLength={4} />}</Field>
        <Field label="Licence expiry" hint="Must be in the future.">{(id) => <input id={id} type="date" value={exp} onChange={(e) => setExp(e.target.value)} required />}</Field>
        <Button type="submit" busy={onboard.isPending}>Submit for verification</Button>
      </form>
    </Panel>
  );
}

function Console({ driver }: { driver: Driver }) {
  const qc = useQueryClient();
  const verified = driver.verificationStatus === "VERIFIED";
  const live = useLiveLocation(verified);
  const [pos, setPos] = useState<Pt>({ lat: CITY_CENTER.lat + 0.004, lng: CITY_CENTER.lng + 0.003 });
  const [simulate, setSimulate] = useState(false); // real GPS by default; "demo mode" only for trying the app without driving
  const posRef = useRef(pos);
  posRef.current = pos;
  const liveRef = useRef(live.pos);
  liveRef.current = live.pos;
  const [riderPos, setRiderPos] = useState<(Pt & { at: number }) | null>(null);
  const [showMech, setShowMech] = useState(true);
  const [chat, setChat] = useState(false);
  useEffect(() => { if (!simulate && live.pos) setPos({ lat: live.pos.lat, lng: live.pos.lng }); }, [live.pos, simulate]);

  const active = useQuery({ queryKey: ["driver", "ride"], queryFn: async () => (await get<{ ride: Ride | null }>("/rides/driver/current")).ride, refetchInterval: 6000 });
  const available = useQuery({
    queryKey: ["driver", "available"], enabled: driver.isOnline && !active.data,
    queryFn: async () => (await get<{ rides: Ride[] }>("/rides/available")).rides, refetchInterval: 4000,
  });
  const ride = active.data ?? null;

  const online = useAction(() => post(driver.isOnline ? "/drivers/offline" : "/drivers/online"), { ok: driver.isOnline ? "You're offline" : "You're online", invalidate: [["driver"]] });
  const step = useAction((a: { id: string; action: string }) => post(`/rides/${a.id}/${a.action}`), { invalidate: [["driver"], ["ride"]] });
  const accept = useAction((id: string) => post(`/rides/${id}/accept`), { ok: "Ride accepted", invalidate: [["driver"]] });

  // While online, tell the server (and the rider, if you have a trip) where you are every 3 seconds. Real GPS by default.
  // Demo mode walks a pretend position toward the pickup/destination so you can try the app without driving.
  useEffect(() => {
    if (!driver.isOnline) return;
    const s = connectSocket();
    const timer = window.setInterval(() => {
      if (simulate) {
        const target = ride ? (ride.status === "TRIP_STARTED" ? ride.dropoff : ride.pickup) : null;
        const cur = posRef.current;
        let next: Pt;
        if (target && !["DRIVER_ARRIVED", "TRIP_COMPLETED"].includes(ride!.status)) {
          const dLat = target.lat - cur.lat, dLng = target.lng - cur.lng;
          const dist = Math.hypot(dLat, dLng);
          const stepSize = 0.0006;
          next = dist < stepSize ? { lat: target.lat, lng: target.lng } : { lat: cur.lat + (dLat / dist) * stepSize, lng: cur.lng + (dLng / dist) * stepSize };
        } else next = { lat: cur.lat + (Math.random() - 0.5) * 0.0002, lng: cur.lng + (Math.random() - 0.5) * 0.0002 };
        setPos(next);
        posRef.current = next;
      } else if (!liveRef.current) return; // no real fix yet: never broadcast a made-up position
      s.emit("driver:location:update", { lat: posRef.current.lat, lng: posRef.current.lng, heading: liveRef.current?.heading ?? 90, speedKmh: 25 });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [driver.isOnline, simulate, ride]);

  // Hear where the customer is while they come to the pickup (the rider's phone shares it into the ride room).
  useEffect(() => {
    if (!ride) { setRiderPos(null); return; }
    const s = connectSocket();
    const join = () => s.emit("ride:join", { rideId: ride.id });
    const onRider = (p: { rideId: string; lat: number; lng: number }) => { if (p.rideId === ride.id) setRiderPos({ lat: p.lat, lng: p.lng, at: Date.now() }); };
    join(); s.on("connect", join); s.on("rider:location:update", onRider);
    return () => { s.off("connect", join); s.off("rider:location:update", onRider); s.emit("ride:leave", { rideId: ride.id }); };
  }, [ride?.id]);

  const mech = useQuery({
    queryKey: ["mechanics-near", pos.lat.toFixed(3), pos.lng.toFixed(3)], enabled: verified,
    queryFn: async () => (await get<{ garages: Garage[] }>("/garages/nearby", { lat: pos.lat, lng: pos.lng, radiusMeters: 15000 })).garages,
    staleTime: 30_000,
  });

  const markers: MapPoint[] = [
    { ...pos, icon: "driver", popup: "You", heading: live.pos?.heading ?? 0, noFit: !ride },
    ...(ride ? [{ ...ride.pickup, icon: "pickup" as const, popup: "Pickup" }, { ...ride.dropoff, icon: "dropoff" as const, popup: "Destination" }] : []),
    ...(ride && riderPos ? [{ lat: riderPos.lat, lng: riderPos.lng, icon: "customer" as const, popup: "Customer (live)" }] : []),
    ...(showMech && !ride ? (mech.data ?? []).map((g) => ({ ...g.location, icon: "garage" as const, popup: g.name, noFit: true })) : []),
    ...(!ride ? (available.data ?? []).map((r) => ({ ...r.pickup, icon: "pickup" as const, popup: `Pickup: ${r.pickup.address}`, noFit: true })) : []),
  ];
  const fitKey = ride ? `${ride.id}:${ride.status}:${!!riderPos}` : "idle";

  if (!verified) {
    return (
      <Panel title="Verification pending" className="max-w-xl">
        <p className="mb-3">Your licence <strong>{driver.licenseNumber}</strong> is <StatusBadge status={driver.verificationStatus} />. An admin has to approve it before you can go online.</p>
        <Button variant="ghost" onClick={() => qc.invalidateQueries({ queryKey: ["driver"] })}>Check again</Button>
      </Panel>
    );
  }

  const first = ride?.rider?.fullName?.split(" ")[0] ?? "the customer";
  const banner = !ride ? null
    : ride.status === "DRIVER_ASSIGNED" || ride.status === "DRIVER_ARRIVING" ? { t: "Head to the pickup point", sub: riderPos ? `${first} is sharing their live location` : `Waiting for ${first}'s location`, c: "bg-brand-soft text-brand" }
    : ride.status === "DRIVER_ARRIVED" ? { t: `You have arrived`, sub: `Wait for ${first}, then start the trip`, c: "bg-earn/10 text-earn-ink" }
    : ride.status === "TRIP_STARTED" ? { t: "Trip in progress", sub: `Take ${first} to the destination`, c: "bg-brand-soft text-brand" }
    : ride.status === "TRIP_COMPLETED" ? { t: "Trip finished", sub: "Waiting for the rider to pay", c: "bg-ride/15 text-ride-ink" }
    : { t: humanize(ride.status), sub: "", c: "bg-concrete" };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
      <div className="space-y-3">
        <MapView markers={markers} fit fitKey={fitKey} height="min(62vh, 620px)" zoom={15} center={pos} />
        {!simulate && <LocationStatus quiet status={live.status} error={live.error} accuracy={live.pos?.accuracy} retry={live.retry} />}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl bg-white px-4 py-3 text-sm font-semibold shadow-card">
          <label className="flex items-center gap-2 text-mute">
            <input type="checkbox" className="!h-4 !w-4" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} />
            Demo mode: pretend to drive (no real GPS needed)
          </label>
          {!ride && <label className="flex items-center gap-2 text-mute"><input type="checkbox" className="!h-4 !w-4" checked={showMech} onChange={(e) => setShowMech(e.target.checked)} />Show mechanics on the map</label>}
        </div>
      </div>

      <div className="space-y-4">
        <Panel>
          <div className="mb-4 flex items-center gap-3">
            <span className={cn("flex h-12 w-12 items-center justify-center rounded-full", driver.isOnline ? "bg-earn/15 text-earn-ink" : "bg-concrete text-mute")}><Navigation size={22} aria-hidden /></span>
            <div className="min-w-0 flex-1"><p className="font-display text-lg font-extrabold">{driver.isOnline ? "You're online" : "You're offline"}</p><p className="text-xs font-semibold text-mute">{driver.isOnline ? "Riders near you can find you" : "Go online to get ride requests"}</p></div>
          </div>
          <div className="mb-4 grid grid-cols-3 gap-3 text-center">
            {[["Rating", Number(driver.ratingAvg).toFixed(1)], ["Trips", String(driver.totalRides)], ["Vehicle", driver.currentVehicleId ? "Assigned" : "None"]].map(([k, v]) => (
              <div key={k} className="rounded-2xl bg-concrete px-2 py-2.5"><p className="text-[11px] font-bold uppercase tracking-wide text-mute">{k}</p><p className="num font-display text-base font-extrabold">{v}</p></div>
            ))}
          </div>
          {!driver.currentVehicleId && <p className="mb-3 rounded-2xl bg-ride/15 px-4 py-3 text-sm font-semibold text-ride-ink">No vehicle is assigned to you yet. Ask a vehicle owner to assign one before you go online.</p>}
          <Button className="w-full !py-4" variant={driver.isOnline ? "ink" : "primary"} busy={online.isPending} disabled={!driver.currentVehicleId && !driver.isOnline} onClick={() => online.mutate(undefined)}>
            {driver.isOnline ? "Go offline" : "Go online"}
          </Button>
        </Panel>

        {ride ? (
          <Panel title="Active trip" action={<StatusBadge status={ride.status} />}>
            {banner && <div className={cn("mb-4 flex items-center gap-3 rounded-3xl px-4 py-3.5", banner.c)} role="status"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/80"><Check size={20} aria-hidden /></span><div className="min-w-0"><p className="font-display text-base font-extrabold leading-tight">{banner.t}</p>{banner.sub && <p className="text-sm font-medium opacity-80">{banner.sub}</p>}</div></div>}

            {ride.rider && (
              <div className="mb-4 flex items-center gap-3 rounded-3xl bg-concrete p-3.5">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand font-display text-lg font-extrabold text-white" aria-hidden>{ride.rider.fullName[0]?.toUpperCase()}</span>
                <p className="min-w-0 flex-1 truncate font-display text-base font-extrabold">{ride.rider.fullName}</p>
                {ride.rider.phone && <a href={`tel:${ride.rider.phone}`} className="round-btn !h-11 !w-11 !shadow-card" aria-label={`Call ${ride.rider.fullName}`}><Phone size={18} aria-hidden /></a>}
                <button type="button" className="round-btn !h-11 !w-11 !bg-brand !text-white !shadow-card" onClick={() => setChat(true)} aria-label={`Chat with ${ride.rider.fullName}`}><MessageCircle size={18} aria-hidden /></button>
              </div>
            )}

            <ol className="space-y-2.5 text-[15px] font-semibold">
              <li className="flex items-center gap-3"><span className="ml-1 h-3.5 w-3.5 shrink-0 rounded-full border-[3px] border-white bg-earn ring-2 ring-earn/40" aria-hidden /><span className="min-w-0">{ride.pickup.address}</span></li>
              <li className="flex items-center gap-3"><MapPin size={18} className="shrink-0 text-repair" aria-hidden /><span className="min-w-0">{ride.dropoff.address}</span></li>
            </ol>
            <p className="num mt-3 text-sm font-semibold text-mute">{km(ride.distanceMeters)}{ride.fare && <> · <span className="text-ink">{inr(ride.fare.totalFare)}</span></>}</p>
            {ride.status !== "TRIP_STARTED" && ride.status !== "TRIP_COMPLETED" && (
              <p className="num mt-2 rounded-2xl bg-concrete px-4 py-2.5 text-sm font-semibold text-mute">You are {km(distanceM(pos, ride.pickup))} from the pickup point{riderPos && <> · customer is {km(distanceM(riderPos, ride.pickup))} from it</>}</p>
            )}
            <div className="mt-4 grid gap-3">
              {NEXT[ride.status] && <Button className="w-full !py-4 !text-base" busy={step.isPending} onClick={() => step.mutate({ id: ride.id, action: NEXT[ride.status]!.action })}>{NEXT[ride.status]!.label}</Button>}
              {["DRIVER_ASSIGNED", "DRIVER_ARRIVING", "TRIP_STARTED"].includes(ride.status) && (
                <a className="btn btn-ghost" target="_blank" rel="noreferrer noopener" href={directionsUrl(ride.status === "TRIP_STARTED" ? ride.dropoff : ride.pickup, pos)}><Navigation size={18} aria-hidden />Navigate</a>
              )}
              {ride.status === "TRIP_COMPLETED" && <Badge tone="warn">Waiting for the rider to pay</Badge>}
              {["DRIVER_ASSIGNED", "DRIVER_ARRIVING", "DRIVER_ARRIVED"].includes(ride.status) && <Button variant="danger" onClick={() => step.mutate({ id: ride.id, action: "cancel" })}>Cancel</Button>}
            </div>
          </Panel>
        ) : driver.isOnline ? (
          <Panel title="Ride requests">
            {available.isLoading ? <Loading /> : !available.data?.length ? <Empty title="No requests right now">Stay online. New requests show up here as riders book.</Empty> : (
              <ul className="space-y-3">{available.data.map((r) => (
                <li key={r.id} className="rounded-3xl bg-concrete p-4">
                  <ol className="space-y-1.5 text-sm font-semibold">
                    <li className="flex items-center gap-3"><span className="ml-0.5 h-3 w-3 shrink-0 rounded-full border-[3px] border-white bg-earn ring-2 ring-earn/40" aria-hidden /><span className="min-w-0 truncate">{r.pickup.address}</span></li>
                    <li className="flex items-center gap-2.5"><MapPin size={16} className="shrink-0 text-repair" aria-hidden /><span className="min-w-0 truncate">{r.dropoff.address}</span></li>
                  </ol>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <p className="num text-xs font-semibold text-mute">{km(r.distanceMeters)} · {dt(r.requestedAt)}{r.surgeMultiplier > 1 && ` · ${r.surgeMultiplier}× surge`}</p>
                    <Button size="sm" busy={accept.isPending} onClick={() => accept.mutate(r.id)}>Accept</Button>
                  </div>
                </li>
              ))}</ul>
            )}
          </Panel>
        ) : <Empty title="You're offline">Go online to start receiving ride requests.</Empty>}
        <Panel title="Mechanics near you">
          <p className="mb-3 text-sm text-mute">Garages within 15 km of where you are now. Useful if the vehicle needs a check-up or breaks down.</p>
          {mech.isLoading ? <Loading /> : !mech.data?.length ? <Empty title="No garages found nearby">Try again when you have moved, or check your location is on.</Empty> : (
            <ul className="divide-y divide-rule">
              {mech.data.slice(0, 6).map((g) => (
                <li key={g.id} className="flex items-start gap-3 py-3">
                  <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-brand-soft text-brand"><Wrench size={18} aria-hidden /></span>
                  <div className="min-w-0 flex-1 text-sm">
                    <Link to={`/repair/garages/${g.id}`} className="block truncate font-display font-extrabold hover:underline">{g.name}</Link>
                    <p className="num text-mute">{g.distanceMeters != null ? `${km(g.distanceMeters)} away` : g.address}{g.ratingAvg != null && <> · <Star size={12} className="inline -mt-0.5" fill="currentColor" aria-hidden /> {Number(g.ratingAvg).toFixed(1)}</>}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <a className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer noopener" href={directionsUrl(g.location, pos)}><Navigation size={14} aria-hidden />Directions</a>
                      {g.phone && <a className="btn btn-ghost btn-sm" href={`tel:${g.phone}`}><Phone size={14} aria-hidden />Call</a>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <p className="text-xs text-mute">{humanize("position")}: {pos.lat.toFixed(4)}, {pos.lng.toFixed(4)}</p>
      </div>
      {chat && ride?.rider && <RideChat rideId={ride.id} otherName={ride.rider.fullName} onClose={() => setChat(false)} />}
    </div>
  );
}

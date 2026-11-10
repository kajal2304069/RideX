import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Mic, ChevronDown, Clock, LoaderCircle, LocateFixed, MapPin, MessageCircle, Phone, Share2, ShieldAlert, Star, X, Zap } from "lucide-react";
import { get, post, errorMessage } from "@/lib/api";
import { connectSocket } from "@/lib/socket";
import { inr, km, mins, newKey, cn, humanize } from "@/lib/format";
import { Button, ErrorNote, Loading, Modal } from "@/components/ui";
import { MapView, MapPoint, bearing } from "@/components/MapView";
import { PlaceSearch } from "@/components/PlaceSearch";
import { TripStage } from "@/components/TripStage";
import { RideChat } from "@/components/RideChat";
import { addressFor, distanceM, Place } from "@/lib/maps";
import { PayModal } from "@/components/PayModal";
import { RateRide } from "@/components/RateRide";
import { LocationStatus } from "@/components/LocationStatus";
import { useAction, useMyLocation, useVehicleTypes } from "@/hooks/useApi";
import { useLiveLocation } from "@/hooks/useLiveLocation";
import { useMedia } from "@/hooks/useMedia";
import { toast } from "@/store/toast";
import { vehicleIcon } from "./vehicleIcons";
import { ACTIVE_BEFORE_START, Estimate, NearbyDriver, Ride, RoutePath } from "./rideTypes";

type Pt = { lat: number; lng: number };
const LIVE = ["DRIVER_ASSIGNED", "DRIVER_ARRIVING", "DRIVER_ARRIVED", "TRIP_STARTED"];
/** A city vehicle averages about 25 km/h, which is 417 metres a minute. */
const etaMin = (meters: number) => Math.max(1, Math.round(meters / 417));
const clock = (min: number) => new Date(Date.now() + min * 60_000).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

export function BookRide() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [rateFor, setRateFor] = useState<string | null>(null);
  const current = useQuery({ queryKey: ["ride", "current"], queryFn: async () => (await get<{ ride: Ride | null }>("/rides/current")).ride, refetchInterval: 8000 });
  // Keep the live ride in sync the moment the server pushes a change.
  useEffect(() => {
    const s = connectSocket();
    const refresh = () => { qc.invalidateQueries({ queryKey: ["ride"] }); };
    const events = ["ride:status_changed", "ride:accepted", "ride:started", "ride:completed", "ride:cancelled", "ride:payment_completed"];
    events.forEach((e) => s.on(e, refresh));
    return () => { events.forEach((e) => s.off(e, refresh)); };
  }, [qc]);

  if (current.isLoading) return <div className="p-6"><Loading /></div>;
  return (
    <div data-line="ride">
      {current.data ? <ActiveRide ride={current.data} onPaid={() => setRateFor(current.data!.id)} /> : <Planner />}
      {/* Lives here (not inside the trip screen) so it stays open after payment, when the trip is no longer "current". */}
      {rateFor && <RateRide rideId={rateFor} who="your driver" onClose={() => { setRateFor(null); nav("/home"); }} onRated={() => qc.invalidateQueries({ queryKey: ["ride"] })} />}
    </div>
  );
}

/** Opens the voice helper. (On a phone the floating microphone is hidden on this screen so it never covers the map cards.) */
function AskBtn() {
  return <button type="button" aria-label="Ask RideX" title="Ask RideX" onClick={() => window.dispatchEvent(new Event("ridex:assistant"))} className="round-btn !h-10 !w-10 !shadow-card md:hidden"><Mic size={18} aria-hidden /></button>;
}

function RoundBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} className="round-btn">{children}</button>;
}

/* ------------------------------------------------------------------ booking ------------------------------------------------------------------ */

function Planner() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const isMd = useMedia("(min-width: 768px)");
  const { pos: fallbackPos, real: fallbackReal } = useMyLocation();
  const live = useLiveLocation();
  const me = live.pos;
  const pos = me ? { lat: me.lat, lng: me.lng } : fallbackPos;
  const real = !!me || fallbackReal;
  const types = useVehicleTypes();
  const [pickup, setPickup] = useState<Pt | null>(null);
  const [dropoff, setDropoff] = useState<Pt | null>(null);
  const [pickupText, setPickupText] = useState("");
  const [dropText, setDropText] = useState("");
  const [typeId, setTypeId] = useState<string>("");
  const [key, setKey] = useState(newKey);
  const [focus, setFocus] = useState<{ lat: number; lng: number; n: number } | null>(null);
  const [details, setDetails] = useState(false);

  // Like every ride app: the first time we know where you are, that is your pickup, until you choose otherwise.
  const autoPickup = useRef(false);
  useEffect(() => {
    if (!me || autoPickup.current || pickup) return;
    autoPickup.current = true;
    setPickup({ lat: me.lat, lng: me.lng }); setPickupText("My current location");
    void addressFor(me).then((a) => { if (a) setPickupText(a); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  const rideTypes = (types.data ?? []).filter((t) => t.category !== "RENTAL");
  useEffect(() => { if (!typeId && rideTypes.length) setTypeId(rideTypes.find((t) => t.code === "SEDAN")?.id ?? rideTypes[0].id); }, [rideTypes, typeId]);

  const ready = !!(pickup && dropoff && typeId);
  const estimate = useQuery({
    queryKey: ["estimate", pickup, dropoff, typeId], enabled: ready,
    queryFn: () => post<Estimate>("/rides/estimate", { pickup, dropoff, vehicleTypeId: typeId }),
  });
  const route = useQuery({
    queryKey: ["route", pickup, dropoff], enabled: !!(pickup && dropoff),
    queryFn: () => post<RoutePath>("/routing/route", { from: pickup, to: dropoff }), retry: false,
  });
  const near = pickup ?? pos;
  const nearby = useQuery({
    queryKey: ["nearby", near.lat.toFixed(3), near.lng.toFixed(3), typeId],
    queryFn: async () => (await get<{ drivers: NearbyDriver[] }>("/location/drivers/nearby", { lat: near.lat, lng: near.lng, radiusMeters: 5000, vehicleTypeId: typeId || undefined })).drivers,
    refetchInterval: 10_000,
  });

  const request = useAction(
    () => post<{ ride: Ride }>("/rides/request", {
      pickup: { ...pickup!, address: pickupText || "Pickup pin" }, dropoff: { ...dropoff!, address: dropText || "Destination pin" },
      vehicleTypeId: typeId, idempotencyKey: key,
    }),
    { ok: "Looking for a driver", onDone: () => { setKey(newKey()); qc.invalidateQueries({ queryKey: ["ride"] }); } }
  );

  const markers: MapPoint[] = [
    ...(me ? [{ lat: me.lat, lng: me.lng, icon: "me" as const, popup: "You are here", noFit: true }] : []),
    ...(pickup ? [{ ...pickup, icon: "pickup" as const, popup: "Pickup" }] : []),
    ...(dropoff ? [{ ...dropoff, icon: "dropoff" as const, popup: "Destination" }] : []),
    ...(nearby.data ?? []).map((d) => ({ lat: d.lat, lng: d.lng, icon: "driver" as const, popup: `Driver, ${km(d.distanceMeters)} away`, noFit: true })),
  ];
  const fare = estimate.data?.fare;
  const picked = rideTypes.find((t) => t.id === typeId);
  const nDrivers = nearby.data?.length ?? 0;

  const setFrom = (p: Place) => { setPickup({ lat: p.lat, lng: p.lng }); };
  const setTo = (p: Place) => { setDropoff({ lat: p.lat, lng: p.lng }); };
  // A map tap fills pickup first, then destination; the address is looked up afterwards so the box never stays blank.
  function pick(p: Pt) {
    const toPickup = !pickup || (pickup && dropoff);
    if (toPickup) { setPickup(p); setDropoff(null); setDropText(""); setPickupText("Finding address…"); void addressFor(p).then((a) => setPickupText(a || "Pin on map")); }
    else { setDropoff(p); setDropText("Finding address…"); void addressFor(p).then((a) => setDropText(a || "Pin on map")); }
  }
  const fitKey = `${pickup ? `${pickup.lat.toFixed(4)},${pickup.lng.toFixed(4)}` : "-"}|${dropoff ? `${dropoff.lat.toFixed(4)},${dropoff.lng.toFixed(4)}` : "-"}`;

  return (
    <TripStage
      map={<MapView bare height="100%" markers={markers} route={route.data?.path} onPick={pick} fit fitKey={fitKey} focus={focus} center={pos} zoom={real ? 15 : 13}
        padding={isMd ? { left: 440, top: 30, bottom: 30, right: 90 } : { top: 200, bottom: 400 }} />}
      top={
        <div className="float-card p-3.5">
          <div className="mb-3 flex items-center gap-3">
            <button type="button" onClick={() => nav("/home")} className="round-btn !h-10 !w-10 !shadow-card" aria-label="Back to home"><ArrowLeft size={18} aria-hidden /></button>
            <h1 className="flex-1 text-lg sm:text-lg">Where to?</h1>
            {(pickup || dropoff) && <button type="button" className="text-sm font-bold text-brand" onClick={() => { setPickup(null); setDropoff(null); setPickupText(""); setDropText(""); }}>Clear</button>}
            <AskBtn />
          </div>
          <div className="space-y-2.5">
            <PlaceSearch label="Pickup" accent="#16A34A" value={pickupText} onText={setPickupText} onSelect={setFrom} onClear={() => setPickup(null)} bias={pickup ?? pos} locate placeholder="Where should we pick you up?" />
            <PlaceSearch label="Destination" accent="#E5412D" value={dropText} onText={setDropText} onSelect={setTo} onClear={() => setDropoff(null)} bias={pickup ?? pos} placeholder="Where are you going?" />
          </div>
          <div className="mt-2"><LocationStatus quiet status={live.status} error={live.error} accuracy={me?.accuracy} retry={live.retry} /></div>
        </div>
      }
      fabsRight={<RoundBtn label="My location" onClick={() => (me ? setFocus({ lat: me.lat, lng: me.lng, n: Date.now() }) : live.retry())}><LocateFixed size={22} aria-hidden /></RoundBtn>}
      sheet={
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg">Choose your ride</h2>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1 text-xs font-bold text-brand"><Zap size={13} aria-hidden />{nDrivers} nearby</span>
          </div>

          {types.isLoading ? <Loading /> : (
            <div className="no-scrollbar -mx-5 flex gap-3 overflow-x-auto px-5 pb-1" role="radiogroup" aria-label="Vehicle type">
              {rideTypes.map((t) => { const Icon = vehicleIcon(t.code); const on = typeId === t.id; return (
                <button key={t.id} role="radio" aria-checked={on} onClick={() => setTypeId(t.id)}
                  className={cn("w-[128px] shrink-0 rounded-3xl border-2 p-3 text-left transition", on ? "border-brand bg-brand-soft" : "border-transparent bg-concrete hover:border-brand/30")}>
                  <span className={cn("flex h-11 w-11 items-center justify-center rounded-2xl", on ? "bg-brand text-white" : "bg-white text-brand")}><Icon size={22} aria-hidden /></span>
                  <span className="mt-2 block font-display text-[15px] font-extrabold">{t.name}</span>
                  <span className="num block text-xs font-semibold text-mute">from {inr(t.baseFare)}</span>
                </button>); })}
            </div>
          )}

          {!ready && <p className="mt-4 rounded-2xl bg-concrete px-4 py-3 text-sm font-semibold text-mute">{!pickup ? "Set your pickup point to begin." : "Search a destination above, or tap it on the map, to see the price."}</p>}

          {ready && (
            <div className="mt-4">
              {estimate.isLoading ? <Loading label="Working out the fare" /> : estimate.error ? <ErrorNote error={new Error(errorMessage(estimate.error))} /> : fare && estimate.data && (
                <div className="space-y-3">
                  <div className="flex items-end justify-between rounded-3xl bg-concrete px-4 py-3.5">
                    <div><p className="text-xs font-bold uppercase tracking-wide text-mute">{picked?.name} fare</p><p className="num font-display text-3xl font-extrabold">{inr(fare.totalFare)}</p></div>
                    <div className="num text-right text-sm font-semibold text-mute"><p className="flex items-center justify-end gap-1.5"><Clock size={14} aria-hidden />{mins(estimate.data.durationSeconds)}</p><p className="flex items-center justify-end gap-1.5"><MapPin size={14} aria-hidden />{km(estimate.data.distanceMeters)}</p></div>
                  </div>
                  {fare.surgeMultiplier > 1 && <p className="rounded-2xl bg-ride/15 px-4 py-2.5 text-sm font-semibold text-ride-ink">Busy right now: fares are {fare.surgeMultiplier}× higher than usual.</p>}
                  <button type="button" onClick={() => setDetails((d) => !d)} aria-expanded={details} className="flex w-full items-center justify-between text-sm font-bold text-brand">Price breakdown <ChevronDown size={16} className={cn("transition", details && "rotate-180")} aria-hidden /></button>
                  {details && (
                    <dl className="num space-y-1 rounded-2xl bg-concrete p-4 text-sm">
                      {([["Base fare", fare.baseFare], ["Distance", fare.distanceCharge], ["Time", fare.timeCharge], ["Booking fee", fare.bookingFee], ["Tax", fare.tax]] as const).map(([l, v]) => (
                        <div key={l} className="flex justify-between"><dt className="text-mute">{l}</dt><dd className="font-semibold">{inr(v)}</dd></div>
                      ))}
                      {fare.discount > 0 && <div className="flex justify-between"><dt className="text-mute">Discount</dt><dd className="font-semibold">-{inr(fare.discount)}</dd></div>}
                      {route.data && <p className="pt-2 text-xs text-mute">Route found by {route.data.algorithm.name} over {route.data.totalGraphNodes} junctions ({route.data.nodesExplored} explored, {route.data.algorithm.timeComplexity}).</p>}
                    </dl>
                  )}
                  <Button className="w-full !py-4 !text-base" busy={request.isPending} onClick={() => request.mutate(undefined)}>Request {picked?.name ?? "ride"}</Button>
                </div>
              )}
            </div>
          )}
        </div>
      }
    />
  );
}

/* ------------------------------------------------------------------ live tracking ------------------------------------------------------------------ */

function Banner({ tone, icon, title, sub, right }: { tone: "blue" | "green" | "amber" | "red"; icon: React.ReactNode; title: string; sub?: string; right?: React.ReactNode }) {
  const c = { blue: "bg-brand-soft text-brand", green: "bg-earn/10 text-earn-ink", amber: "bg-ride/15 text-ride-ink", red: "bg-repair/10 text-repair-ink" }[tone];
  return (
    <div className={cn("flex items-center gap-3 rounded-3xl px-4 py-3.5", c)} role="status">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/80">{icon}</span>
      <div className="min-w-0 flex-1"><p className="font-display text-base font-extrabold leading-tight">{title}</p>{sub && <p className="text-sm font-medium opacity-80">{sub}</p>}</div>
      {right && <div className="num shrink-0 text-right font-display text-lg font-extrabold">{right}</div>}
    </div>
  );
}

function ActiveRide({ ride, onPaid }: { ride: Ride; onPaid: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const isMd = useMedia("(min-width: 768px)");
  const [driverPos, setDriverPos] = useState<(Pt & { at: number; heading: number }) | null>(null);
  const [paying, setPaying] = useState(false);
  const [chat, setChat] = useState(false);
  const [safety, setSafety] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [focus, setFocus] = useState<{ lat: number; lng: number; n: number } | null>(null);
  const sharing = LIVE.includes(ride.status);
  const live = useLiveLocation(sharing);
  const me = live.pos;
  const meRef = useRef(me);
  meRef.current = me;
  const d = ride.driver;

  // Tell the driver where the customer is standing: the latest position every 4 seconds while a driver is on the way.
  useEffect(() => {
    if (!sharing) return;
    const send = () => { const p = meRef.current; if (p) connectSocket().emit("rider:location:update", { lat: p.lat, lng: p.lng, accuracy: p.accuracy }); };
    send();
    const t = window.setInterval(send, 4000);
    return () => window.clearInterval(t);
  }, [sharing, ride.id, ride.status]);

  // Join this ride's room: the server relays the driver's GPS to everyone in it. The car faces the way it is travelling.
  useEffect(() => {
    const s = connectSocket();
    const join = () => s.emit("ride:join", { rideId: ride.id });
    const onLoc = (p: { rideId: string; lat: number; lng: number; heading?: number }) => {
      if (p.rideId !== ride.id) return;
      setDriverPos((prev) => {
        const moved = prev && distanceM(prev, p) > 4;
        const heading = moved ? bearing(prev, p) : prev?.heading ?? (typeof p.heading === "number" ? p.heading : 0);
        return { lat: p.lat, lng: p.lng, at: Date.now(), heading };
      });
    };
    join();
    s.on("connect", join); // rejoin after a reconnect
    s.on("driver:location:update", onLoc);
    return () => { s.off("connect", join); s.off("driver:location:update", onLoc); s.emit("ride:leave", { rideId: ride.id }); };
  }, [ride.id]);

  const toward = ride.status === "TRIP_STARTED" ? ride.dropoff : ride.pickup;
  const showDriver = !!driverPos && sharing;
  const route = useQuery({
    queryKey: ["route", "live", ride.id, ride.status, driverPos ? driverPos.lat.toFixed(3) : "-", driverPos ? driverPos.lng.toFixed(3) : "-"],
    enabled: showDriver,
    queryFn: () => post<RoutePath>("/routing/route", { from: { lat: driverPos!.lat, lng: driverPos!.lng }, to: toward }),
    retry: false,
  });
  const fullRoute = useQuery({ queryKey: ["route", ride.id], queryFn: () => post<RoutePath>("/routing/route", { from: ride.pickup, to: ride.dropoff }), retry: false });
  const liveRoute = route.data?.path;
  // If no road route can be drawn (a place outside the sample map), draw a dashed straight line instead of nothing.
  const straight = showDriver && !liveRoute ? [{ lat: driverPos!.lat, lng: driverPos!.lng }, toward] : undefined;

  const cancel = useAction(() => post(`/rides/${ride.id}/cancel`, { reason: "Changed my mind" }), { ok: "Ride cancelled", invalidate: [["ride"]], onDone: () => setConfirmCancel(false) });

  const remaining = showDriver ? (route.data?.distanceMeters ?? distanceM(driverPos!, toward)) : null;
  const eta = remaining != null ? etaMin(remaining) : null;
  const total = ride.distanceMeters ?? fullRoute.data?.distanceMeters ?? distanceM(ride.pickup, ride.dropoff);
  const pct = ride.status === "TRIP_STARTED" && remaining != null && total > 0 ? Math.min(96, Math.max(4, Math.round((1 - remaining / total) * 100))) : 4;

  const markers: MapPoint[] = [
    ...(me && sharing ? [{ lat: me.lat, lng: me.lng, icon: "me" as const, popup: "You are here", noFit: true }] : []),
    { ...ride.pickup, icon: "pickup", popup: "Pickup" }, { ...ride.dropoff, icon: "dropoff", popup: "Destination" },
    ...(showDriver ? [{ lat: driverPos!.lat, lng: driverPos!.lng, icon: "driver" as const, popup: d?.fullName ?? "Your driver", heading: driverPos!.heading }] : []),
  ];
  const fitKey = `${ride.id}:${ride.status}:${showDriver}`;
  const canCancel = ACTIVE_BEFORE_START.includes(ride.status);
  const v = d?.vehicle;
  const vehicleLine = v ? [v.color, [v.brand, v.model].filter(Boolean).join(" "), v.typeName].filter(Boolean).join(" · ") : "";
  const first = d?.fullName?.split(" ")[0] ?? "Your driver";

  async function share() {
    const text = `I'm on a RideX ride from ${ride.pickup.address} to ${ride.dropoff.address}.${d ? ` Driver: ${d.fullName}${v?.registrationNumber ? `, vehicle ${v.registrationNumber}` : ""}.` : ""} Destination: https://www.google.com/maps/search/?api=1&query=${ride.dropoff.lat},${ride.dropoff.lng}`;
    try {
      if (navigator.share) await navigator.share({ title: "My RideX trip", text });
      else { await navigator.clipboard.writeText(text); toast.ok("Trip details copied. Paste them into a message."); }
    } catch { /* the person closed the share sheet */ }
  }

  let banner: React.ReactNode;
  switch (ride.status) {
    case "REQUESTED": case "SEARCHING_DRIVER":
      banner = <Banner tone="blue" icon={<LoaderCircle className="animate-spin" size={22} aria-hidden />} title="Finding your driver…" sub="This page updates by itself. Keep it open." />; break;
    case "DRIVER_ASSIGNED": case "DRIVER_ARRIVING":
      banner = <Banner tone="green" icon={<Check size={22} aria-hidden />} title="Your driver is approaching" sub={`Get ready! ${first} is on the way.`} right={eta != null ? `${eta} min` : undefined} />; break;
    case "DRIVER_ARRIVED":
      banner = <Banner tone="green" icon={<MapPin size={22} aria-hidden />} title="Your driver has arrived!" sub={`Meet ${first} at the pickup point.`} />; break;
    case "TRIP_STARTED":
      banner = (
        <div className="rounded-3xl bg-brand-soft px-4 py-3.5 text-brand" role="status">
          <div className="flex items-center justify-between"><p className="font-display text-base font-extrabold">Your ride is underway</p>{eta != null && <p className="text-sm font-bold">Arriving at <span className="num text-earn-ink">{clock(eta)}</span></p>}</div>
          <div className="relative mt-3 h-2.5 rounded-full bg-white" aria-label={`Trip ${pct}% done`}>
            <div className="h-full rounded-full bg-brand transition-all duration-1000" style={{ width: `${pct}%` }} />
            <span className="absolute -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-white text-brand shadow-card transition-all duration-1000" style={{ left: `calc(${pct}% - 12px)` }}><Zap size={13} fill="currentColor" aria-hidden /></span>
          </div>
        </div>); break;
    case "TRIP_COMPLETED":
      banner = <Banner tone="amber" icon={<Check size={22} aria-hidden />} title="You've reached your destination" sub="Please pay to finish your trip." right={ride.fare ? inr(ride.fare.totalFare) : undefined} />; break;
    case "PAYMENT_COMPLETED":
      banner = <Banner tone="green" icon={<Check size={22} aria-hidden />} title="Paid. Thank you!" sub="How was your ride?" />; break;
    default:
      banner = <Banner tone="red" icon={<X size={22} aria-hidden />} title="This ride was cancelled" sub={ride.cancellationReason ?? undefined} />;
  }

  return (
    <>
      <TripStage
        map={<MapView bare height="100%" markers={markers} route={liveRoute ?? straight ?? fullRoute.data?.path} routeDashed={!liveRoute && !!straight} fit fitKey={fitKey} focus={focus}
          padding={isMd ? { left: 440, top: 30, bottom: 30, right: 90 } : { top: 190, bottom: 430 }} />}
        top={
          <div className="float-card p-3.5">
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => nav("/home")} className="round-btn !h-10 !w-10 !shadow-card" aria-label="Back to home"><ArrowLeft size={18} aria-hidden /></button>
              <div className="min-w-0 flex-1"><h1 className="text-lg sm:text-lg">Your route</h1><p className="text-xs font-semibold text-mute">{humanize(ride.status)}</p></div>
              <AskBtn />
            </div>
            <ol className="mt-3 space-y-2.5 text-[15px] font-semibold">
              <li className="flex items-center gap-3"><span className="ml-1 h-3.5 w-3.5 shrink-0 rounded-full border-[3px] border-white bg-earn ring-2 ring-earn/40" aria-hidden /><span className="min-w-0 truncate">{ride.pickup.address}</span></li>
              <li className="flex items-center gap-3"><MapPin size={18} className="shrink-0 text-repair" aria-hidden /><span className="min-w-0 truncate">{ride.dropoff.address}</span></li>
            </ol>
            {sharing && <div className="mt-2"><LocationStatus quiet status={live.status} error={live.error} accuracy={me?.accuracy} retry={live.retry} /></div>}
          </div>
        }
        fabsLeft={sharing ? <><RoundBtn label="Share my trip" onClick={share}><Share2 size={20} aria-hidden /></RoundBtn><RoundBtn label="Safety" onClick={() => setSafety(true)}><ShieldAlert size={20} aria-hidden /></RoundBtn></> : undefined}
        fabsRight={<RoundBtn label={showDriver ? "Show my driver" : "My location"} onClick={() => { const p = showDriver ? driverPos : me; if (p) setFocus({ lat: p.lat, lng: p.lng, n: Date.now() }); else live.retry(); }}><LocateFixed size={22} aria-hidden /></RoundBtn>}
        sheet={
          <div className="space-y-4">
            {banner}

            {d && ride.status !== "SEARCHING_DRIVER" && (
              <div className="rounded-3xl bg-concrete p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brand font-display text-xl font-extrabold text-white" aria-hidden>{d.fullName[0]?.toUpperCase()}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-display text-lg font-extrabold leading-tight">{d.fullName}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-sm font-bold text-ride-ink"><Star size={14} fill="currentColor" aria-hidden /><span className="num">{d.ratingAvg ? d.ratingAvg.toFixed(2) : "New"}</span><span className="font-medium text-mute">· {d.totalRides} trips</span></p>
                    {vehicleLine && <p className="mt-1 text-sm font-medium text-mute">{vehicleLine}</p>}
                  </div>
                  {v?.registrationNumber && <p className="num rounded-2xl bg-white px-3 py-2 text-center font-display text-sm font-extrabold tracking-wider shadow-card">{v.registrationNumber}</p>}
                </div>
                {sharing && (
                  <div className={cn("mt-4 grid gap-3", d.phone ? "grid-cols-2" : "grid-cols-1")}>
                    {d.phone && <a href={`tel:${d.phone}`} className="btn btn-ghost !min-h-[48px]"><Phone size={18} aria-hidden />Call</a>}
                    <button type="button" className="btn btn-primary !min-h-[48px]" onClick={() => setChat(true)}><MessageCircle size={18} aria-hidden />Chat</button>
                  </div>
                )}
              </div>
            )}

            <dl className="num grid grid-cols-3 gap-3 text-center">
              {[["Distance", km(ride.distanceMeters)], [ride.fare ? "Fare" : "Est. time", ride.fare ? inr(ride.fare.totalFare) : mins(ride.durationSeconds)], ["Payment", ride.status === "PAYMENT_COMPLETED" ? "Paid" : "At end"]].map(([k, val]) => (
                <div key={k} className="rounded-2xl bg-concrete px-2 py-2.5"><dt className="text-[11px] font-bold uppercase tracking-wide text-mute">{k}</dt><dd className="font-display text-base font-extrabold">{val}</dd></div>
              ))}
            </dl>

            {ride.status === "TRIP_COMPLETED" && <Button className="w-full !py-4 !text-base" onClick={() => setPaying(true)}>Pay {ride.fare ? inr(ride.fare.totalFare) : "now"}</Button>}
            {ride.status.startsWith("CANCELLED") && <Link to="/home" className="btn btn-primary w-full">Back to home</Link>}
            {canCancel && !confirmCancel && <button type="button" className="w-full rounded-2xl py-2.5 text-sm font-bold text-repair-ink hover:bg-repair/10" onClick={() => setConfirmCancel(true)}>Cancel ride</button>}
            {canCancel && confirmCancel && (
              <div className="rounded-3xl bg-repair/10 p-4"><p className="mb-3 text-sm font-bold">Cancel this ride?</p>
                <div className="grid grid-cols-2 gap-3"><Button variant="ghost" onClick={() => setConfirmCancel(false)}>Keep ride</Button><Button variant="danger" busy={cancel.isPending} onClick={() => cancel.mutate(undefined)}>Yes, cancel</Button></div></div>
            )}
          </div>
        }
      />

      {paying && <PayModal type="RIDE" id={ride.id} amount={ride.fare?.totalFare} title="Pay for your trip" onClose={() => setPaying(false)} onPaid={() => { qc.invalidateQueries({ queryKey: ["payments"] }); onPaid(); qc.invalidateQueries({ queryKey: ["ride"] }); }} />}
      {chat && d && <RideChat rideId={ride.id} otherName={d.fullName} onClose={() => setChat(false)} />}
      {safety && (
        <Modal title="Safety" onClose={() => setSafety(false)}>
          <div className="space-y-3">
            <a href="tel:112" className="btn btn-danger w-full !py-4"><ShieldAlert size={20} aria-hidden />Call emergency number (112)</a>
            <button type="button" className="btn btn-ghost w-full" onClick={() => { void share(); setSafety(false); }}><Share2 size={18} aria-hidden />Share my trip details</button>
            {d?.phone && <a href={`tel:${d.phone}`} className="btn btn-ghost w-full"><Phone size={18} aria-hidden />Call {first}</a>}
            <p className="text-xs text-mute">Your driver sees where you are only while this ride is live. If you feel unsafe, call 112 first.</p>
          </div>
        </Modal>
      )}
    </>
  );
}

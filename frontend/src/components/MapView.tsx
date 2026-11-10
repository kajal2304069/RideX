/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { googleEnabled, loadGoogle } from "@/lib/maps";
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";

export const CITY_CENTER = { lat: 12.9716, lng: 77.5946 };

// ---------- marker artwork (shared by the Leaflet and Google maps) ----------
const shadow = "filter:drop-shadow(0 3px 5px rgba(11,27,43,.35))";
const badge = (bg: string, fg: string, label: string, round = false) => `<div style="display:flex;flex-direction:column;align-items:center;${shadow}">
  <div style="min-width:30px;height:30px;padding:0 5px;background:${bg};color:${fg};border:3px solid #fff;border-radius:${round ? "50%" : "14px 14px 14px 4px"};font:800 13px 'Plus Jakarta Sans Variable',sans-serif;display:flex;align-items:center;justify-content:center">${label}</div>
  <div style="width:3px;height:7px;background:#fff;border-radius:2px"></div></div>`;
/** Destination: a red drop pin with a white centre, like a real maps app. */
const dropPin = `<div style="${shadow};width:34px;height:42px"><svg width="34" height="42" viewBox="0 0 34 42"><path d="M17 40C17 40 3 25.5 3 16a14 14 0 0 1 28 0c0 9.5-14 24-14 24z" fill="#E5412D" stroke="#fff" stroke-width="3"/><circle cx="17" cy="16" r="5.5" fill="#fff"/></svg></div>`;
/** Pickup: a green dot with a white ring. */
const startDot = `<div style="${shadow};width:26px;height:26px;border-radius:50%;background:#16A34A;border:4px solid #fff"></div>`;
/** A vehicle seen from above, pointing north; rotated by `heading` so it faces the way it is travelling. */
const carHtml = (heading: number) => `<div style="position:relative;width:48px;height:48px;display:flex;align-items:center;justify-content:center">
  <span style="position:absolute;inset:0;border-radius:50%;background:rgba(27,31,208,.16)"></span>
  <svg width="32" height="52" viewBox="0 0 32 52" style="transform:rotate(${heading}deg);transition:transform .6s linear;${shadow}"><rect x="1" y="10" width="4" height="9" rx="2" fill="#0B0D1F"/><rect x="27" y="10" width="4" height="9" rx="2" fill="#0B0D1F"/><rect x="1" y="34" width="4" height="9" rx="2" fill="#0B0D1F"/><rect x="27" y="34" width="4" height="9" rx="2" fill="#0B0D1F"/><rect x="4" y="2" width="24" height="48" rx="11" fill="#1F2433" stroke="#fff" stroke-width="2.5"/><path d="M9 18 Q16 14 23 18 L22 25 H10 Z" fill="#9DB0FF"/><rect x="9.5" y="27" width="13" height="8" rx="2" fill="#323A5C"/><path d="M10 37 H22 L23 42 Q16 45 9 42 Z" fill="#9DB0FF" opacity=".8"/><rect x="8" y="4" width="5" height="3" rx="1.5" fill="#FFE27A"/><rect x="19" y="4" width="5" height="3" rx="1.5" fill="#FFE27A"/></svg></div>`;
const meHtml = `<div style="position:relative;width:22px;height:22px"><span style="position:absolute;inset:-8px;border-radius:50%;background:#2563EB;opacity:.25;animation:rx-pulse 1.8s ease-out infinite"></span><span style="position:absolute;inset:0;border-radius:50%;background:#2563EB;border:3px solid #fff;box-shadow:0 2px 6px rgba(11,27,43,.4)"></span></div>`;

export type IconKind = "pickup" | "dropoff" | "driver" | "customer" | "me" | "garage" | "car" | "listing";
const SIZE: Record<IconKind, [number, number, number, number]> = { // w, h, anchorX, anchorY
  pickup: [26, 26, 13, 13], dropoff: [34, 42, 17, 40], driver: [48, 48, 24, 24], customer: [34, 40, 17, 38], me: [22, 22, 11, 11], garage: [34, 40, 17, 38], car: [34, 40, 17, 38], listing: [34, 40, 17, 38],
};
const html = (k: IconKind, heading: number) =>
  k === "pickup" ? startDot : k === "dropoff" ? dropPin : k === "driver" ? carHtml(heading) : k === "me" ? meHtml
  : k === "customer" ? badge("#2563EB", "#fff", "C", true) : k === "garage" ? badge("#D9472B", "#fff", "G") : k === "car" ? badge("#0B8A8A", "#fff", "R") : badge("#5A3FD0", "#fff", "S");
const GLIDES: IconKind[] = ["driver", "customer", "me"];

const cache = new Map<string, L.DivIcon>();
/** Icons are cached (rotation rounded to 10 degrees) so a moving marker keeps the same element and can glide. */
export function iconFor(kind: IconKind, heading = 0): L.DivIcon {
  const h = kind === "driver" ? Math.round(((heading % 360) + 360) % 360 / 10) * 10 : 0;
  const key = `${kind}-${h}`;
  let ic = cache.get(key);
  if (!ic) {
    const [w, hh, ax, ay] = SIZE[kind];
    ic = L.divIcon({ className: GLIDES.includes(kind) ? "rx-glide" : "", iconSize: [w, hh], iconAnchor: [ax, ay], html: html(kind, h) });
    cache.set(key, ic);
  }
  return ic;
}
/** Compass bearing in degrees from one point to another (0 = north, clockwise). */
export function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = Math.PI / 180, y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

export interface MapPoint { lat: number; lng: number; label?: string; icon?: IconKind; popup?: string; heading?: number; /** Show it, but do not stretch the camera to include it (nearby cars, your own dot). */ noFit?: boolean }
export interface FitPadding { top?: number; right?: number; bottom?: number; left?: number }
type MapProps = {
  markers?: MapPoint[]; route?: Array<{ lat: number; lng: number }>; onPick?: (p: { lat: number; lng: number }) => void;
  fit?: boolean; height?: number | string; center?: { lat: number; lng: number }; zoom?: number;
  /** Space the floating cards cover, so the route is framed in the visible part of the map. */
  padding?: FitPadding;
  /** Change `n` to move the camera to this point (used by the "my location" button). */
  focus?: { lat: number; lng: number; n: number } | null;
  /** No border or rounded corners: for a map that fills its whole screen. */
  bare?: boolean;
  /** Draw the route as a dashed straight line (used when no road route could be found). */
  routeDashed?: boolean;
  /** When set, the camera re-frames only when this value changes (not every time a marker moves). */
  fitKey?: string;
};

function ClickCatcher({ onClick }: { onClick: (p: { lat: number; lng: number }) => void }) {
  useMapEvents({ click: (e) => onClick({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}
function Fit({ points, padding, fitKey }: { points: Array<{ lat: number; lng: number }>; padding?: FitPadding; fitKey?: string }) {
  const map = useMap();
  const key = fitKey ?? points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join("|") + JSON.stringify(padding ?? {});
  useEffect(() => {
    const tl: [number, number] = [(padding?.left ?? 0) + 40, (padding?.top ?? 0) + 40], br: [number, number] = [(padding?.right ?? 0) + 40, (padding?.bottom ?? 0) + 40];
    if (points.length >= 2) map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])), { paddingTopLeft: tl, paddingBottomRight: br, maxZoom: 16 });
    else if (points.length === 1) map.setView([points[0].lat, points[0].lng], Math.max(map.getZoom(), 15));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}
function FocusTo({ focus }: { focus?: MapProps["focus"] }) {
  const map = useMap();
  useEffect(() => { if (focus) map.flyTo([focus.lat, focus.lng], Math.max(map.getZoom(), 16), { duration: 0.8 }); }, [focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
/** Leaflet recalculates its size when its box changes (phone rotation, sheet resize). */
function KeepSize() {
  const map = useMap();
  useEffect(() => { const ro = new ResizeObserver(() => map.invalidateSize()); ro.observe(map.getContainer()); return () => ro.disconnect(); }, [map]);
  return null;
}

function LeafletMapView({ markers = [], route, onPick, fit = true, height = 420, center = CITY_CENTER, zoom = 13, padding, focus, bare, routeDashed, fitKey }: MapProps) {
  const framed = [...markers.filter((m) => !m.noFit), ...(route ?? [])];
  return (
    <div style={{ height }} className={bare ? "relative h-full w-full overflow-hidden" : "relative overflow-hidden rounded-3xl"} role="region" aria-label="Map">
      <MapContainer center={[center.lat, center.lng]} zoom={zoom} style={{ height: "100%", width: "100%" }} scrollWheelZoom zoomControl={!bare} className="rx-map">
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <KeepSize />
        {onPick && <ClickCatcher onClick={onPick} />}
        {fit && framed.length > 0 && <Fit points={framed} padding={padding} fitKey={fitKey} />}
        <FocusTo focus={focus} />
        {route && route.length > 1 && <Polyline positions={route.map((p) => [p.lat, p.lng])} pathOptions={{ color: "#FFFFFF", weight: 11, opacity: 0.95, lineCap: "round", lineJoin: "round", dashArray: routeDashed ? "1 14" : undefined }} />}
        {route && route.length > 1 && <Polyline positions={route.map((p) => [p.lat, p.lng])} pathOptions={{ color: "#16A34A", weight: 6, lineCap: "round", lineJoin: "round", dashArray: routeDashed ? "1 14" : undefined }} />}
        {markers.map((m, i) => (
          // Stable key (kind + position in the list) so a moving marker is updated in place and glides instead of being re-created.
          <Marker key={`${m.icon ?? "pickup"}-${i}`} position={[m.lat, m.lng]} icon={iconFor(m.icon ?? "pickup", m.heading)} zIndexOffset={m.icon === "driver" ? 1000 : 0}>
            {(m.popup || m.label) && <Popup>{m.popup ?? m.label}</Popup>}
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}

/** Google Maps version with the same props. Calls onFail if Google cannot load, so the Leaflet map can take over. */
function GoogleMapView({ markers = [], route, onPick, fit = true, height = 420, center = CITY_CENTER, zoom = 13, padding, focus, bare, routeDashed, fitKey, onFail }: MapProps & { onFail: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const overlays = useRef<any[]>([]);
  const pick = useRef(onPick); pick.current = onPick;
  const [ready, setReady] = useState(false);
  const lastFit = useRef<string | undefined>(undefined);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const g = await loadGoogle();
        const { Map } = await g.maps.importLibrary("maps");
        await g.maps.importLibrary("marker");
        if (dead || !el.current) return;
        map.current = new Map(el.current, { center, zoom, mapId: "DEMO_MAP_ID", gestureHandling: "greedy", clickableIcons: false, fullscreenControl: false, streetViewControl: false, mapTypeControl: false, zoomControl: !bare });
        map.current.addListener("click", (e: any) => pick.current?.({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
        setReady(true);
      } catch { if (!dead) onFail(); }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const key = JSON.stringify([markers, route, fit, padding]);
  useEffect(() => {
    if (!ready) return;
    const g = (window as any).google; const m = map.current;
    overlays.current.forEach((o) => (o.setMap ? o.setMap(null) : (o.map = null))); overlays.current = [];
    const bounds = new g.maps.LatLngBounds(); let n = 0;
    const info = new g.maps.InfoWindow();
    for (const mk of markers) {
      const kind = (mk.icon ?? "pickup") as IconKind;
      const holder = document.createElement("div"); holder.innerHTML = html(kind, mk.heading ?? 0);
      const adv = new g.maps.marker.AdvancedMarkerElement({ map: m, position: { lat: mk.lat, lng: mk.lng }, content: holder.firstElementChild as HTMLElement, title: mk.label ?? mk.popup });
      if (mk.popup || mk.label) adv.addListener("click", () => { info.setContent(`<div style="font:600 14px sans-serif;color:#0D0F2B">${(mk.popup ?? mk.label ?? "").replace(/[<>&]/g, "")}</div>`); info.open({ map: m, anchor: adv }); });
      overlays.current.push(adv); if (!mk.noFit) { bounds.extend({ lat: mk.lat, lng: mk.lng }); n++; }
    }
    if (route && route.length > 1) {
      const dash = routeDashed ? { strokeOpacity: 0, icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 3 }, offset: "0", repeat: "14px" }] } : {};
      for (const [color, w, o] of [["#FFFFFF", 10, 0.95], ["#16A34A", 5.5, 1]] as const) overlays.current.push(new g.maps.Polyline({ map: m, path: route, strokeColor: color, strokeWeight: w, strokeOpacity: o, ...dash }));
      route.forEach((p) => { bounds.extend(p); n++; });
    }
    const pad = { top: (padding?.top ?? 0) + 40, right: (padding?.right ?? 0) + 40, bottom: (padding?.bottom ?? 0) + 40, left: (padding?.left ?? 0) + 40 };
    const refit = fit && (fitKey === undefined || lastFit.current !== fitKey);
    if (refit && n >= 2) { m.fitBounds(bounds, pad); lastFit.current = fitKey; }
    else if (refit && n === 1) { m.setCenter([...markers.filter((x) => !x.noFit), ...(route ?? [])][0] as any); m.setZoom(Math.max(m.getZoom() ?? 15, 15)); lastFit.current = fitKey; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, key]);

  useEffect(() => { if (ready && !fit) map.current.setCenter(center); }, [ready, fit, center.lat, center.lng]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready && focus) { map.current.panTo({ lat: focus.lat, lng: focus.lng }); map.current.setZoom(16); } }, [ready, focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div style={{ height }} className={bare ? "relative h-full w-full overflow-hidden bg-concrete" : "relative overflow-hidden rounded-3xl bg-concrete"} role="region" aria-label="Map"><div ref={el} className="h-full w-full" /></div>;
}

/** Google Maps when VITE_GOOGLE_MAPS_API_KEY was set at build time and loads; OpenStreetMap otherwise. */
export function MapView(props: MapProps) {
  const [failed, setFailed] = useState(false);
  if (googleEnabled && !failed) return <GoogleMapView {...props} onFail={() => setFailed(true)} />;
  return <LeafletMapView {...props} />;
}

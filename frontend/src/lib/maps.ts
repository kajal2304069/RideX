/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Maps + place search, with two interchangeable providers:
 *  - Google Maps (JavaScript API + Places API (New) + Geocoding API) when VITE_GOOGLE_MAPS_API_KEY is set at build time;
 *  - OpenStreetMap (Leaflet tiles + Nominatim search) otherwise, so the app works with no key and no billing.
 * Everything the screens need goes through the small interface at the bottom of this file.
 */
export const GOOGLE_KEY: string | undefined = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim() || undefined;
export const googleEnabled = !!GOOGLE_KEY;

export interface LatLng { lat: number; lng: number }
export interface Place extends LatLng { address: string; name?: string }
export interface Suggestion { id: string; primary: string; secondary?: string; resolve: () => Promise<Place> }

let loader: Promise<any> | null = null;
/** Loads the Google Maps script once. Rejects (so callers can fall back) if the key is wrong or the network blocks it. */
export function loadGoogle(): Promise<any> {
  const w = window as any;
  if (w.google?.maps?.importLibrary) return Promise.resolve(w.google);
  loader ??= new Promise((resolve, reject) => {
    w.__ridexMapsReady = () => resolve(w.google);
    w.gm_authFailure = () => { loader = null; reject(new Error("Google Maps rejected the API key")); };
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_KEY!)}&v=weekly&loading=async&callback=__ridexMapsReady`;
    s.async = true;
    s.onerror = () => { loader = null; reject(new Error("Could not load Google Maps")); };
    document.head.appendChild(s);
  });
  return loader;
}

// ---------- OpenStreetMap / Nominatim ----------
const NOMINATIM = "https://nominatim.openstreetmap.org";
async function osmSuggest(query: string, bias: LatLng, signal?: AbortSignal): Promise<Suggestion[]> {
  const d = 0.6; // roughly 65 km: prefer results near the user without forbidding others
  const url = `${NOMINATIM}/search?format=jsonv2&limit=6&countrycodes=in&q=${encodeURIComponent(query)}&viewbox=${bias.lng - d},${bias.lat + d},${bias.lng + d},${bias.lat - d}`;
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Place search is unavailable right now");
  const rows = (await res.json()) as Array<{ place_id: number; display_name: string; name?: string; lat: string; lon: string }>;
  return rows.map((r) => {
    const parts = r.display_name.split(", ");
    return { id: String(r.place_id), primary: r.name || parts[0], secondary: parts.slice(1, 4).join(", "),
      resolve: async () => ({ lat: Number(r.lat), lng: Number(r.lon), address: r.display_name, name: r.name || parts[0] }) };
  });
}
async function osmReverse(p: LatLng): Promise<string> {
  const res = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=18&lat=${p.lat}&lon=${p.lng}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("reverse failed");
  const j = (await res.json()) as { display_name?: string };
  return j.display_name ?? "";
}

// ---------- Google ----------
let sessionToken: any = null;
async function googleSuggest(query: string, bias: LatLng): Promise<Suggestion[]> {
  const g = await loadGoogle();
  const { AutocompleteSuggestion, AutocompleteSessionToken } = await g.maps.importLibrary("places");
  sessionToken ??= new AutocompleteSessionToken(); // one token per typing session keeps Places billing per-session
  const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
    input: query, sessionToken, includedRegionCodes: ["in"], locationBias: { center: bias, radius: 50000 },
  });
  return (suggestions as any[]).filter((s) => s.placePrediction).slice(0, 6).map((s) => {
    const p = s.placePrediction;
    return { id: p.placeId, primary: p.mainText?.text ?? p.text.text, secondary: p.secondaryText?.text,
      resolve: async () => {
        const place = p.toPlace();
        await place.fetchFields({ fields: ["location", "formattedAddress", "displayName"] });
        sessionToken = null; // the session ends when a place is chosen
        return { lat: place.location.lat(), lng: place.location.lng(), address: place.formattedAddress ?? p.text.text, name: place.displayName ?? undefined };
      } };
  });
}
async function googleReverse(p: LatLng): Promise<string> {
  const g = await loadGoogle();
  const { Geocoder } = await g.maps.importLibrary("geocoding");
  const r = await new Geocoder().geocode({ location: p });
  return r.results?.[0]?.formatted_address ?? "";
}

// ---------- what the screens use ----------
/** Place suggestions for what the person has typed so far. Falls back to OpenStreetMap if Google fails (bad key, quota). */
export async function suggestPlaces(query: string, bias: LatLng, signal?: AbortSignal): Promise<Suggestion[]> {
  if (googleEnabled) { try { return await googleSuggest(query, bias); } catch { /* fall through to OSM */ } }
  return osmSuggest(query, bias, signal);
}
/** A readable address for a point (used after "use my location" or a map tap). Never throws: returns "" if unknown. */
export async function addressFor(p: LatLng): Promise<string> {
  try { return googleEnabled ? await googleReverse(p) : await osmReverse(p); }
  catch { try { return googleEnabled ? await osmReverse(p) : ""; } catch { return ""; } }
}

/** The device's position, with a plain-language reason when it fails. */
export function currentPosition(): Promise<LatLng & { accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("This device cannot share its location. Search for the place instead."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.code === e.PERMISSION_DENIED ? "Location is blocked. Allow it in your browser settings, or search for the place." : e.code === e.TIMEOUT ? "Could not get your location in time. Try again, or search for the place." : "Could not find your location. Search for the place instead.")),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    );
  });
}

/** Straight-line distance in metres between two points (good enough for "how far is the customer"). */
export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** A link that opens turn-by-turn directions in the phone's maps app (Google Maps), whichever map the page shows. */
export const directionsUrl = (to: LatLng, from?: LatLng) =>
  `https://www.google.com/maps/dir/?api=1&destination=${to.lat},${to.lng}${from ? `&origin=${from.lat},${from.lng}` : ""}&travelmode=driving`;

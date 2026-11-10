import { useCallback, useEffect, useRef, useState } from "react";

export interface LivePos { lat: number; lng: number; accuracy: number; heading: number | null; at: number }
export type LiveStatus = "idle" | "asking" | "live" | "denied" | "unavailable";

const explain = (e: GeolocationPositionError) =>
  e.code === e.PERMISSION_DENIED ? "Location is blocked. Allow it in your browser (tap the lock next to the address), then press Try again."
  : e.code === e.TIMEOUT ? "Could not get your location in time. Move to open sky or check your connection, then try again."
  : "Your device could not work out where you are. Check that location is switched on.";

/**
 * The device's position, kept up to date while `enabled`. Never throws: a refusal becomes status "denied" with a plain
 * message, so every screen can keep working with a search box or the map instead.
 */
export function useLiveLocation(enabled = true) {
  const [pos, setPos] = useState<LivePos | null>(null);
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [error, setError] = useState("");
  const watch = useRef<number | null>(null);

  const stop = useCallback(() => { if (watch.current !== null) { navigator.geolocation.clearWatch(watch.current); watch.current = null; } }, []);
  const start = useCallback(() => {
    stop();
    if (!("geolocation" in navigator)) { setStatus("unavailable"); setError("This device cannot share its location."); return; }
    setStatus("asking"); setError("");
    watch.current = navigator.geolocation.watchPosition(
      (p) => { setPos({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, heading: p.coords.heading, at: Date.now() }); setStatus("live"); setError(""); },
      (e) => { setStatus(e.code === e.PERMISSION_DENIED ? "denied" : "unavailable"); setError(explain(e)); },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
  }, [stop]);

  useEffect(() => { if (enabled) start(); else stop(); return stop; }, [enabled, start, stop]);
  return { pos, status, error, retry: start };
}

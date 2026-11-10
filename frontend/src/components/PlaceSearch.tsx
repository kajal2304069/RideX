import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, LocateFixed, MapPin, X } from "lucide-react";
import { LatLng, Place, Suggestion, addressFor, currentPosition, suggestPlaces } from "@/lib/maps";
import { cn } from "@/lib/format";

/**
 * A place box with live suggestions (Google Places or OpenStreetMap), keyboard support, and a "use my location" button.
 * Controlled by `value` (what to show) and reports a chosen place through `onSelect`.
 */
export function PlaceSearch({ label, value, onText, onSelect, onClear, bias, placeholder, locate, accent }: {
  label: string; value: string; onText: (t: string) => void; onSelect: (p: Place) => void; onClear?: () => void;
  bias: LatLng; placeholder?: string; locate?: boolean; accent?: string;
}) {
  const id = useId();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [hi, setHi] = useState(-1);
  const typed = useRef(false);

  // Debounced search: only when the person typed (not when we filled the box ourselves), and never for 1-2 characters.
  useEffect(() => {
    if (!typed.current || value.trim().length < 3) { setItems([]); return; }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true); setMsg("");
      try { const r = await suggestPlaces(value.trim(), bias, ctl.signal); setItems(r); setOpen(true); setHi(-1); if (!r.length) setMsg("No places found. Try a nearby landmark."); }
      catch (e) { if ((e as Error).name !== "AbortError") setMsg("Place search is unavailable. You can also tap the map."); }
      finally { setBusy(false); }
    }, 350);
    return () => { clearTimeout(t); ctl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  async function choose(s: Suggestion) {
    setBusy(true);
    try { const p = await s.resolve(); typed.current = false; setOpen(false); setItems([]); onText(p.name ? `${p.name}, ${p.address}`.slice(0, 200) : p.address); onSelect(p); }
    catch { setMsg("Could not open that place. Try another."); }
    finally { setBusy(false); }
  }

  async function useMyLocation() {
    setMsg(""); setBusy(true);
    try {
      const pos = await currentPosition();
      const address = (await addressFor(pos)) || "My current location";
      typed.current = false; onText(address); onSelect({ lat: pos.lat, lng: pos.lng, address, name: "My location" });
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  }

  function onKey(e: React.KeyboardEvent) {
    if (!open || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (h + 1) % items.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (h <= 0 ? items.length - 1 : h - 1)); }
    else if (e.key === "Enter" && hi >= 0) { e.preventDefault(); void choose(items[hi]); }
    else if (e.key === "Escape") setOpen(false);
  }

  return (
    <div className="relative">
      <label htmlFor={id} className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: accent ?? "var(--line)" }} aria-hidden />{label}
      </label>
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <MapPin size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mute" aria-hidden />
          <input id={id} role="combobox" aria-expanded={open && items.length > 0} aria-controls={`${id}-list`} aria-autocomplete="list" autoComplete="off" enterKeyHint="search"
            className="!pl-10 !pr-9" value={value} placeholder={placeholder ?? "Search a place"}
            onChange={(e) => { typed.current = true; onText(e.target.value); setOpen(true); }} onFocus={() => items.length && setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={onKey} />
          <span className="absolute right-2 top-1/2 -translate-y-1/2">
            {busy ? <LoaderCircle size={18} className="animate-spin text-mute" aria-label="Searching" /> : value && onClear ? (
              <button type="button" className="rounded-full p-1 text-mute hover:bg-slate-100" aria-label={`Clear ${label}`} onClick={() => { typed.current = false; onText(""); setItems([]); onClear(); }}><X size={16} /></button>) : null}
          </span>
        </div>
        {locate && (
          <button type="button" onClick={useMyLocation} className="btn btn-ghost !px-3" aria-label="Use my current location" title="Use my current location"><LocateFixed size={20} aria-hidden /></button>
        )}
      </div>
      {open && items.length > 0 && (
        <ul id={`${id}-list`} role="listbox" className="absolute left-0 right-0 z-[1200] mt-1 max-h-72 overflow-auto rounded-2xl border border-slate-200 bg-white p-1 shadow-lift">
          {items.map((s, i) => (
            <li key={s.id} role="option" aria-selected={i === hi}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void choose(s)}
                className={cn("flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-slate-50", i === hi && "bg-slate-100")}>
                <MapPin size={18} className="mt-0.5 shrink-0 text-mute" aria-hidden />
                <span className="min-w-0"><span className="block truncate text-[15px] font-semibold">{s.primary}</span>{s.secondary && <span className="block truncate text-xs text-mute">{s.secondary}</span>}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {msg && <p role="status" className="mt-1 text-xs text-repair-ink">{msg}</p>}
    </div>
  );
}

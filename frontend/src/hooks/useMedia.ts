import { useEffect, useState } from "react";

/** True while the CSS media query matches (e.g. "(min-width: 768px)"). Safe where matchMedia does not exist. */
export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}

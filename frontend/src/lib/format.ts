export const inr = (n: number | null | undefined) =>
  n == null ? "–" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n);

export const dt = (v: string | Date | null | undefined) =>
  v ? new Date(v).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "–";

export const dateOnly = (v: string | Date | null | undefined) =>
  v ? new Date(v).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "–";

export const km = (meters: number | null | undefined) => (meters == null ? "–" : meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`);

export const mins = (seconds: number | null | undefined) => (seconds == null ? "–" : `${Math.max(1, Math.round(seconds / 60))} min`);

export const cn = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export const humanize = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** A fresh idempotency key. Create it once per *intent* (when a form opens), reuse it on retries. */
export const newKey = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** `datetime-local` value for a Date. */
export const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

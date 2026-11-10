import { Link, useLocation } from "react-router-dom";
import { ButtonHTMLAttributes, ReactNode, useEffect, useId } from "react";
import { cn } from "@/lib/format";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ink" | "ghost" | "danger"; size?: "md" | "sm"; busy?: boolean };

export function Button({ variant = "primary", size = "md", busy, className, children, disabled, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={cn("btn", `btn-${variant}`, size === "sm" && "btn-sm", className)}
    >
      {busy && <Spinner small />}
      {children}
    </button>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn("inline-block animate-spin rounded-full border-2 border-brand/20 border-t-brand", small ? "h-3.5 w-3.5" : "h-6 w-6")}
    />
  );
}

export function Panel({ title, action, children, className, line }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; line?: string }) {
  return (
    <section className={cn("panel", className)} data-line={line}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-rule px-4 pb-3 pt-4 sm:px-5">
          <h2 className="text-lg">{title}</h2>
          {action}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && !error && <p className="text-xs text-mute">{hint}</p>}
      {error && <p role="alert" className="text-xs font-bold text-repair-ink">{error}</p>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-3xl border border-dashed border-brand/25 bg-white/70 px-4 py-10 text-center">
      <p className="font-display text-base font-bold">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-mute">{children}</div>}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return <div className="flex items-center gap-3 py-8 text-sm text-mute"><Spinner />{label}…</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : String(error);
  return <p role="alert" className="rounded-xl border border-repair/30 bg-repair/5 px-3.5 py-2.5 text-sm">{msg}</p>;
}

export function Badge({ children, tone }: { children: ReactNode; tone?: "good" | "warn" | "bad" | "info" }) {
  const t = tone === "good" ? "!bg-earn/10 !text-earn-ink"
    : tone === "warn" ? "!bg-ride/15 !text-ride-ink"
    : tone === "bad" ? "!bg-repair/10 !text-repair-ink"
    : tone === "info" ? "!bg-brand-soft !text-brand" : "";
  return <span className={cn("badge", t)}>{children}</span>;
}

const GOOD = ["COMPLETED", "PAYMENT_COMPLETED", "SUCCESS", "VERIFIED", "ACTIVE", "CONFIRMED", "PAID", "ACCEPTED", "AVAILABLE", "READY", "ok", "up"];
const BAD = ["CANCELLED", "CANCELLED_BY_RIDER", "CANCELLED_BY_DRIVER", "CANCELLED_BY_SYSTEM", "FAILED", "REJECTED", "EXPIRED", "REFUNDED", "down", "UNAVAILABLE"];
export function StatusBadge({ status }: { status: string }) {
  const tone = GOOD.includes(status) ? "good" : BAD.includes(status) ? "bad" : "warn";
  return <Badge tone={tone}>{status.toLowerCase().replace(/_/g, " ")}</Badge>;
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold uppercase tracking-wide text-mute">{label}</div>
      <div className="num font-display text-xl font-bold leading-tight sm:text-2xl [overflow-wrap:anywhere]">{value}</div>
      {note && <div className="text-xs text-mute">{note}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[1000] flex items-end justify-center bg-ink/50 p-0 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="panel max-h-[92vh] w-full max-w-lg overflow-auto rounded-b-none rounded-t-4xl sm:rounded-b-3xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-rule px-5 pb-3 pt-4">
          <h2 className="text-lg">{title}</h2>
          <button onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full bg-concrete text-xl leading-none hover:bg-brand-soft" aria-label="Close">×</button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: string }>; value: T; onChange: (t: T) => void }) {
  return (
    <div role="tablist" className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn("chip", value === t.id && "is-active")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

const GUIDE_FOR: Array<[string, string]> = [["/ride", "ride"], ["/payments", "ride"], ["/rent", "rent"], ["/drive/rentals", "rent"], ["/buy", "buy"], ["/sell", "buy"], ["/repair", "repair"], ["/drive", "drive"]];

export function PageHeader({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  const { pathname } = useLocation();
  const guideId = GUIDE_FOR.find(([p]) => pathname === p || pathname.startsWith(p + "/"))?.[1];
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 sm:mb-6">
      <div>
        <h1>{title}</h1>
        {guideId && <Link to={`/help?guide=${guideId}`} className="mt-1 inline-flex items-center gap-1 text-sm font-bold text-brand underline-offset-4 hover:underline">How does this work? · कैसे करें?</Link>}
        {sub && <p className="mt-1 max-w-prose text-sm text-mute">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Bell, BadgeIndianRupee, CarFront, CircleHelp, Ellipsis, House, KeyRound, LogOut, Navigation, ShieldCheck, Tag, Wrench, X, type LucideIcon } from "lucide-react";
import { useAuth, Role } from "@/store/auth";
import { get } from "@/lib/api";
import { connectSocket, disconnectSocket } from "@/lib/socket";
import { cn } from "@/lib/format";
import { toast, useToasts } from "@/store/toast";

interface Line { id: string; label: string; to: string; icon: LucideIcon; roles?: Role[]; sub: Array<{ to: string; label: string; roles?: Role[] }> }

/** Product areas. Each has a handful of sub-pages shown as chips above the content. */
export const LINES: Line[] = [
  { id: "ride", label: "Home", to: "/home", icon: House, sub: [] },
  { id: "ride", label: "Ride", to: "/ride", icon: CarFront, sub: [{ to: "/ride", label: "Book a ride" }, { to: "/ride/history", label: "My trips" }, { to: "/payments", label: "Payments" }] },
  { id: "rent", label: "Rent", to: "/rent", icon: KeyRound, sub: [{ to: "/rent", label: "Find a vehicle" }, { to: "/rent/bookings", label: "My rentals" }] },
  { id: "market", label: "Buy", to: "/buy", icon: Tag, sub: [{ to: "/buy", label: "Browse" }, { to: "/buy/activity", label: "Offers & saved" }] },
  { id: "market", label: "Sell", to: "/sell", icon: BadgeIndianRupee, roles: ["SELLER", "VEHICLE_OWNER", "ADMIN"], sub: [{ to: "/sell", label: "My listings" }] },
  { id: "repair", label: "Repair", to: "/repair", icon: Wrench, sub: [{ to: "/repair", label: "Nearby garages" }, { to: "/repair/bookings", label: "My services" }, { to: "/repair/garage", label: "Run a garage", roles: ["GARAGE_OWNER"] }] },
  { id: "earn", label: "Drive & earn", to: "/drive", icon: Navigation, roles: ["DRIVER", "VEHICLE_OWNER"], sub: [
    { to: "/drive", label: "Driver console", roles: ["DRIVER"] },
    { to: "/drive/vehicles", label: "My vehicles", roles: ["VEHICLE_OWNER"] },
    { to: "/drive/rentals", label: "Rental desk", roles: ["VEHICLE_OWNER"] },
    { to: "/drive/earnings", label: "Earnings" },
  ] },
  { id: "admin", label: "Admin", to: "/admin", icon: ShieldCheck, roles: ["ADMIN"], sub: [{ to: "/admin", label: "Console" }] },
];

const inLine = (l: Line, path: string) => (l.to === "/home" ? path === "/home" : l.sub.some((s) => path === s.to || path.startsWith(s.to + "/")) || path.startsWith(l.to));

/** What each kind of person most wants one tap away on a phone. */
const PRIORITY: Partial<Record<Role, string[]>> = {
  ADMIN: ["Admin"], DRIVER: ["Drive & earn", "Ride"], VEHICLE_OWNER: ["Drive & earn", "Rent"], GARAGE_OWNER: ["Repair"],
  SELLER: ["Sell", "Buy"], BUYER: ["Buy"], RIDER: ["Ride", "Rent"],
};

export function Logo({ dark }: { dark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand text-white shadow-[0_6px_14px_-6px_rgba(27,31,208,.9)] ring-2 ring-white/70"><Navigation size={16} fill="currentColor" aria-hidden /></span>
      <span className={cn("font-display text-xl font-extrabold tracking-tight", dark ? "text-ink" : "text-white")}>RideX</span>
    </span>
  );
}

/** Screens that fill the whole display (the map pages). On a phone they hide the header and the bottom menu. */
const IMMERSIVE = (p: string) => p === "/ride";

export function Shell() {
  const { user, logout, has } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const toasts = useToasts((s) => s.toasts);
  const [more, setMore] = useState(false);
  const [welcome, setWelcome] = useState(() => { try { return localStorage.getItem("ridex.welcomed") !== "1"; } catch { return false; } });
  const dismissWelcome = () => { setWelcome(false); try { localStorage.setItem("ridex.welcomed", "1"); } catch { /* private mode */ } };

  const unread = useQuery({ queryKey: ["unread"], queryFn: () => get<{ unread: number }>("/notifications/unread-count"), refetchInterval: 30_000 });
  const unreadN = unread.data?.unread ?? 0;

  useEffect(() => {
    const s = connectSocket();
    const onStatus = (r: { status: string }) => toast.ok(`Ride update: ${r.status.toLowerCase().replace(/_/g, " ")}`);
    s.on("ride:status_changed", onStatus);
    return () => { s.off("ride:status_changed", onStatus); };
  }, []);
  useEffect(() => () => disconnectSocket(), []);
  useEffect(() => setMore(false), [loc.pathname]);

  const immersive = IMMERSIVE(loc.pathname);
  const visible = LINES.filter((l) => !l.roles || has(...l.roles));
  const active = visible.find((l) => inLine(l, loc.pathname));
  const subs = (active?.sub ?? []).filter((s) => !s.roles || has(...s.roles));
  const signOut = () => logout().then(() => nav("/login"));
  const initials = (user?.fullName ?? "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  // Phone tabs: Home first, then what this person's roles use most, then the rest.
  const wanted = (user?.roles ?? []).flatMap((r) => PRIORITY[r] ?? []);
  const phoneTabs = [visible[0], ...[...new Set(wanted)].map((n) => visible.find((l) => l.label === n)), ...visible.slice(1)]
    .filter((l, i, a): l is Line => !!l && a.indexOf(l) === i).slice(0, 4);
  const moreLines = visible.filter((l) => !phoneTabs.includes(l));

  const SideItem = ({ l, compact }: { l: Line; compact?: boolean }) => {
    const on = l === active;
    const Icon = l.icon;
    return (
      <NavLink to={l.to} aria-current={on ? "page" : undefined}
        className={cn("group flex items-center gap-3 rounded-2xl font-display text-[15px] font-bold transition",
          compact ? "flex-col gap-1 px-1 py-2.5 text-[10px]" : "px-3.5 py-3",
          on ? "bg-brand text-white shadow-[0_12px_24px_-12px_rgba(27,31,208,.9)]" : "text-mute hover:bg-brand-soft hover:text-brand")}>
        <Icon size={compact ? 22 : 20} aria-hidden /><span>{l.label}</span>
      </NavLink>
    );
  };

  return (
    <div className="min-h-[100dvh] md:flex" data-line={active?.id ?? "ride"}>
      {/* iPad: icon rail. Laptop: full sidebar. Phone: neither (floating pill menu below). */}
      <aside className="hidden shrink-0 flex-col border-r border-white/70 bg-white/80 backdrop-blur md:sticky md:top-0 md:flex md:h-[100dvh] md:w-[92px] lg:w-[272px]">
        <div className="px-3 py-5 lg:px-6"><div className="hidden lg:block"><Logo dark /></div><div className="flex justify-center lg:hidden"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand text-white shadow-lift"><Navigation size={20} fill="currentColor" aria-label="RideX" /></span></div></div>
        <nav aria-label="Main" className="no-scrollbar flex-1 space-y-1 overflow-y-auto px-2.5 lg:px-4">
          {visible.map((l) => (<div key={l.label}><div className="lg:hidden"><SideItem l={l} compact /></div><div className="hidden lg:block"><SideItem l={l} /></div></div>))}
        </nav>
        <div className="space-y-2 p-2.5 lg:p-4">
          <NavLink to="/help" className="flex items-center justify-center gap-2 rounded-2xl bg-brand-soft px-3 py-3 font-display text-sm font-bold text-brand hover:bg-brand-mid lg:justify-start">
            <CircleHelp size={18} aria-hidden /><span className="hidden lg:inline">Help · मदद</span><span className="sr-only lg:hidden">Help</span>
          </NavLink>
          <button onClick={() => nav("/notifications")} className="relative flex w-full items-center justify-center gap-2 rounded-2xl px-3 py-3 text-sm font-bold text-mute hover:bg-brand-soft hover:text-brand lg:justify-start" aria-label={`Notifications${unreadN ? `, ${unreadN} unread` : ""}`}>
            <Bell size={18} aria-hidden /><span className="hidden lg:inline">Notifications</span>
            {unreadN > 0 && <span className="num absolute right-3 top-1.5 rounded-full bg-repair px-1.5 text-[11px] font-bold text-white lg:static lg:ml-auto">{unreadN}</span>}
          </button>
          <div className="flex items-center gap-3 rounded-2xl bg-concrete p-2">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-sm font-bold text-white" aria-hidden>{initials}</span>
            <div className="hidden min-w-0 flex-1 lg:block"><p className="truncate text-sm font-bold">{user?.fullName}</p><p className="truncate text-xs text-mute">{user?.email}</p></div>
            <button onClick={signOut} className="ml-auto hidden rounded-xl p-2 text-mute hover:bg-white hover:text-ink lg:block" aria-label="Sign out"><LogOut size={18} /></button>
          </div>
          <button onClick={signOut} className="flex w-full items-center justify-center rounded-xl p-2 text-mute hover:bg-brand-soft lg:hidden" aria-label="Sign out"><LogOut size={18} /></button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Phone header (hidden on the full-screen map page) */}
        <header className={cn("sticky top-0 z-[900] flex items-center justify-between px-4 pb-2 pt-3 backdrop-blur-md md:hidden", immersive && "hidden")}>
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand font-display text-sm font-bold text-white shadow-lift" aria-hidden>{initials}</span>
            <div className="leading-tight"><p className="text-xs font-semibold text-mute">Welcome back</p><p className="font-display text-base font-extrabold">{user?.fullName?.split(" ")[0]}</p></div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => nav("/help")} className="flex h-11 items-center gap-1.5 rounded-full bg-white px-4 text-sm font-bold text-brand shadow-card" aria-label="Help"><CircleHelp size={17} aria-hidden />Help</button>
            <button onClick={() => nav("/notifications")} className="relative flex h-11 w-11 items-center justify-center rounded-full bg-white shadow-card" aria-label={`Notifications${unreadN ? `, ${unreadN} unread` : ""}`}>
              <Bell size={19} aria-hidden />{unreadN > 0 && <span className="num absolute -right-0.5 -top-0.5 rounded-full bg-repair px-1.5 text-[10px] font-bold text-white">{unreadN}</span>}
            </button>
          </div>
        </header>

        <main className={cn("min-w-0 flex-1", immersive ? "p-0 md:p-5 lg:p-6" : "px-4 pb-32 pt-3 sm:px-6 md:pb-10 md:pt-7 lg:px-10")}>
          <div className={cn("mx-auto w-full", !immersive && "max-w-[1200px]")}>
            {!immersive && subs.length > 1 && (
              <nav aria-label="Section" className="no-scrollbar -mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
                {subs.map((s) => (
                  <NavLink key={s.to} to={s.to} end className={({ isActive }) => cn("chip", isActive && "is-active")}>{s.label}</NavLink>
                ))}
              </nav>
            )}
            {!immersive && welcome && loc.pathname !== "/home" && (
              <div role="region" aria-label="Welcome" className="mb-5 flex flex-wrap items-center gap-3 rounded-3xl bg-brand-soft px-4 py-3 text-ink">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-white"><CircleHelp size={20} aria-hidden /></span>
                <p className="min-w-[12rem] flex-1 text-base font-bold">New here? See how RideX works, step by step. <span className="block text-sm font-medium text-mute">नए हैं? देखें कि RideX कैसे चलता है।</span></p>
                <button className="btn btn-primary btn-sm" onClick={() => { dismissWelcome(); nav("/help"); }}>Show me</button>
                <button className="btn btn-ghost btn-sm" onClick={dismissWelcome}>Not now</button>
              </div>
            )}
            <Outlet />
          </div>
        </main>
      </div>

      {/* Phone: a floating white pill. The page you are on is a blue capsule with its name; the others are round icons. */}
      {!immersive && (
        <nav aria-label="Main" className="pb-safe fixed inset-x-3 bottom-3 z-[950] md:hidden">
          <div className="mx-auto flex max-w-md items-center justify-between gap-1 rounded-[30px] bg-white p-2 shadow-lift ring-1 ring-brand/5">
            {phoneTabs.map((l) => {
              const on = l === active; const Icon = l.icon;
              return (
                <NavLink key={l.label} to={l.to} aria-label={l.label} aria-current={on ? "page" : undefined}
                  className={cn("flex h-12 items-center justify-center gap-2 rounded-full font-display text-sm font-bold transition-all", on ? "bg-brand px-5 text-white shadow-[0_10px_20px_-10px_rgba(27,31,208,.9)]" : "w-12 text-mute")}>
                  <Icon size={21} aria-hidden />{on && <span>{l.label}</span>}
                </NavLink>
              );
            })}
            <button onClick={() => setMore(true)} aria-label="More" aria-haspopup="dialog" className="flex h-12 w-12 items-center justify-center rounded-full text-mute"><Ellipsis size={22} aria-hidden /></button>
          </div>
        </nav>
      )}

      {more && (
        <div role="dialog" aria-modal="true" aria-label="More" className="fixed inset-0 z-[2000] flex items-end bg-ink/50 md:hidden" onMouseDown={() => setMore(false)}>
          <div className="pb-safe w-full rounded-t-5xl bg-white p-5" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-rule" aria-hidden />
            <div className="mb-4 flex items-center justify-between"><div className="flex items-center gap-3"><span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand font-bold text-white">{initials}</span><div><p className="font-display text-lg font-extrabold">{user?.fullName}</p><p className="text-xs text-mute">{user?.email}</p></div></div><button onClick={() => setMore(false)} className="rounded-full bg-concrete p-2.5" aria-label="Close"><X size={18} /></button></div>
            <div className="grid grid-cols-3 gap-3">
              {moreLines.map((l) => { const Icon = l.icon; return (
                <NavLink key={l.label} to={l.to} className="flex flex-col items-center gap-2 rounded-3xl bg-concrete p-3.5 text-center text-sm font-bold"><span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand text-white"><Icon size={20} aria-hidden /></span>{l.label}</NavLink>); })}
              <NavLink to="/payments" className="flex flex-col items-center gap-2 rounded-3xl bg-concrete p-3.5 text-center text-sm font-bold"><span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand text-white"><BadgeIndianRupee size={20} aria-hidden /></span>Payments</NavLink>
              <NavLink to="/ride/history" className="flex flex-col items-center gap-2 rounded-3xl bg-concrete p-3.5 text-center text-sm font-bold"><span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand text-white"><CarFront size={20} aria-hidden /></span>My trips</NavLink>
            </div>
            <button onClick={signOut} className="btn btn-ghost mt-4 w-full"><LogOut size={18} aria-hidden />Sign out</button>
          </div>
        </div>
      )}

      <div className={cn("pointer-events-none fixed inset-x-3 z-[2200] flex flex-col gap-2 md:inset-x-auto md:bottom-24 md:right-4 md:top-auto md:w-80", immersive ? "top-3" : "top-20")} aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cn("pointer-events-auto rounded-2xl bg-white px-4 py-3 text-sm font-semibold shadow-lift", t.kind === "error" ? "border-l-[6px] border-l-repair" : "border-l-[6px] border-l-brand")}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}

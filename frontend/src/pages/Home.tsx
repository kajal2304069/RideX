import { Link } from "react-router-dom";
import { ArrowRight, CircleHelp, Mic, MousePointerClick, Navigation, Search, ShieldCheck, Wallet, Wrench } from "lucide-react";
import { Photo } from "@/components/Photo";
import { PICS, Pic } from "@/lib/images";
import { Role, useAuth } from "@/store/auth";

const greeting = () => { const h = new Date().getHours(); return h < 5 ? "Hello" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };

const PRODUCTS: Array<{ to: string; line: string; title: string; text: string; pic: Pic; pos?: string }> = [
  { to: "/ride", line: "ride", title: "Ride", text: "A bike, auto or car in minutes. See the price before you book.", pic: PICS.autoRickshaw },
  { to: "/rent", line: "rent", title: "Rent", text: "Drive it yourself by the hour or the day, with a refundable deposit.", pic: PICS.suvRoad },
  { to: "/buy", line: "market", title: "Buy & sell", text: "New and second-hand vehicles near you, checked by a real mechanic before you pay.", pic: PICS.carLot },
  { to: "/repair", line: "repair", title: "Repair", text: "Book a garage nearby, or get roadside help if you break down.", pic: PICS.garage },
];

interface Hero { title: string; cta: string; to: string; placeholder: string; pic: Pic; pos: string }
/** What the top of Home says depends on what the person signed up to do. Riders keep the classic "where to?" search. */
function heroFor(roles: Role[]): Hero {
  const has = (r: Role) => roles.includes(r);
  if (has("RIDER")) return { title: "Where are you going today?", cta: "Book a ride", to: "/ride", placeholder: "Search a destination", pic: PICS.cityTaxi, pos: "center 60%" };
  if (has("DRIVER")) return { title: "Ready to drive today?", cta: "Open driver console", to: "/drive", placeholder: "Go online and get ride requests", pic: PICS.nightCab, pos: "center 55%" };
  if (has("BUYER")) return { title: "Find your next vehicle", cta: "Browse vehicles", to: "/buy", placeholder: "New or second-hand, near you", pic: PICS.carLot, pos: "center 55%" };
  if (has("SELLER")) return { title: "Sell your vehicle", cta: "List a vehicle", to: "/sell", placeholder: "Add photos, a price and a place", pic: PICS.keys, pos: "center 50%" };
  if (has("VEHICLE_OWNER")) return { title: "Put your vehicles to work", cta: "My vehicles", to: "/drive/vehicles", placeholder: "Rent them out or assign a driver", pic: PICS.suvRoad, pos: "center 55%" };
  if (has("GARAGE_OWNER")) return { title: "Your garage, your bookings", cta: "Open garage desk", to: "/repair/garage", placeholder: "See repair jobs and breakdown calls", pic: PICS.garage, pos: "center 50%" };
  return { title: "Welcome to RideX", cta: "Get started", to: "/help", placeholder: "See how everything works", pic: PICS.cityTaxi, pos: "center 60%" };
}

export function Home() {
  const user = useAuth((s) => s.user);
  const first = user?.fullName?.split(" ")[0] ?? "there";
  const earns = user?.roles.some((r) => r === "DRIVER" || r === "VEHICLE_OWNER");
  const hero = heroFor(user?.roles ?? []);
  const driver = user?.roles.includes("DRIVER");

  return (
    <div data-line="ride" className="space-y-8 sm:space-y-10">
      <Photo pic={hero.pic} eager sizes="(min-width:1200px) 1200px, 100vw" position={hero.pos} className="rounded-4xl">
        <div className="flex min-h-[300px] flex-col justify-end p-5 text-white sm:min-h-[360px] sm:p-8">
          <p className="text-sm font-semibold text-white/80">{greeting()}, {first}</p>
          <h1 className="mt-1 max-w-xl text-3xl leading-tight sm:text-5xl">{hero.title}</h1>
          <Link to={hero.to} className="mt-5 flex max-w-xl items-center gap-3 rounded-2xl bg-white px-4 py-3.5 text-ink shadow-lift transition hover:scale-[1.01]">
            <Search size={20} className="text-mute" aria-hidden />
            <span className="flex-1 text-base text-mute">{hero.placeholder}</span>
            <span className="rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white">{hero.cta}</span>
          </Link>
        </div>
      </Photo>

      <section aria-labelledby="products">
        <h2 id="products" className="mb-4 text-xl sm:text-2xl">What do you need?</h2>
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {PRODUCTS.map((p) => (
            <li key={p.to} data-line={p.line}>
              <Link to={p.to} className="group block overflow-hidden rounded-3xl bg-white shadow-card transition hover:-translate-y-0.5 hover:shadow-lift">
                <Photo pic={p.pic} sizes="(min-width:1280px) 280px, (min-width:640px) 45vw, 100vw" className="h-44 sm:h-48">
                  <span className="absolute left-3 top-3 rounded-full bg-white px-3 py-1 text-xs font-extrabold text-brand">{p.title}</span>
                </Photo>
                <div className="p-4">
                  <p className="text-sm text-mute">{p.text}</p>
                  <p className="mt-3 flex items-center gap-1.5 font-display text-sm font-bold text-[var(--line-ink)]">Open {p.title.toLowerCase()} <ArrowRight size={16} className="transition group-hover:translate-x-1" aria-hidden /></p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {earns && (
        <Link to="/drive" data-line="earn" className="flex flex-wrap items-center gap-4 rounded-3xl bg-brand p-5 text-white shadow-lift transition hover:bg-brand-600">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/20"><Navigation size={22} aria-hidden /></span>
          <div className="min-w-[12rem] flex-1"><p className="font-display text-lg font-bold">Drive and earn</p><p className="text-sm text-white/70">Go online, accept rides, and withdraw your earnings to your bank.</p></div>
          <ArrowRight aria-hidden />
        </Link>
      )}

      {driver && (
        <Link to="/repair" data-line="repair" className="flex flex-wrap items-center gap-4 rounded-3xl bg-white p-5 shadow-card transition hover:shadow-lift">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-repair text-white"><Wrench size={22} aria-hidden /></span>
          <div className="min-w-[12rem] flex-1"><p className="font-display text-lg font-bold">Mechanics near you</p><p className="text-sm text-mute">Find garages around your current location, with distance and directions.</p></div>
          <ArrowRight aria-hidden />
        </Link>
      )}

      <section aria-labelledby="how" className="rounded-4xl bg-white p-5 shadow-card sm:p-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><h2 id="how" className="text-xl sm:text-2xl">New here? It takes three steps.</h2><p className="mt-1 text-sm text-mute">No typing needed for most things. You can also ask by voice, in your own language.</p></div>
          <Link to="/help" className="btn btn-primary"><CircleHelp size={18} aria-hidden />See it with pictures · तस्वीरों में देखें</Link>
        </div>
        <ol className="mt-6 grid gap-4 sm:grid-cols-3">
          {[
            { i: MousePointerClick, t: "Choose", d: "Pick where you are and where you want to go, or pick a vehicle." },
            { i: ShieldCheck, t: "Check the price", d: "The full price is shown first. Nothing is charged until you confirm." },
            { i: Wallet, t: "Go and pay", d: "Pay when you arrive, by card or UPI. A double tap never charges twice." },
          ].map((s, n) => (
            <li key={s.t} className="flex gap-4 rounded-2xl bg-concrete p-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-white"><s.i size={21} aria-hidden /></span>
              <div><p className="font-display font-bold"><span className="num mr-1 text-mute">{n + 1}.</span>{s.t}</p><p className="mt-0.5 text-sm text-mute">{s.d}</p></div>
            </li>
          ))}
        </ol>
        <p className="mt-5 flex items-center gap-2 text-sm text-mute"><Mic size={16} aria-hidden />Tap the round microphone button and just say what you need. It speaks back in Hindi, English and 12 more languages.</p>
      </section>

      <p className="text-center text-xs text-mute">
        Photos from Unsplash: {Object.values(PICS).map((p, i) => (<span key={p.id}>{i > 0 && ", "}<a className="underline" href={p.page} target="_blank" rel="noreferrer noopener">{p.credit}</a></span>))}
      </p>
    </div>
  );
}

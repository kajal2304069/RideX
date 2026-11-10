import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, BadgeCheck, MessageCircle, Phone, CarFront, CircleHelp, KeyRound, LocateFixed, Mic, Navigation, Search, ShieldCheck, Tag, Wallet, Wrench, MapPin, Star, ClipboardCheck, Users, Bike, HandCoins } from "lucide-react";
import { Photo } from "@/components/Photo";
import { PICS } from "@/lib/images";
import { Logo } from "@/components/Shell";
import { cn } from "@/lib/format";

const join = (role: string) => `/login?mode=register&role=${role}`;

const ROLES = [
  { role: "RIDER", icon: CarFront, title: "Book a ride", text: "Bike, auto or car to your door. See the price first.", pic: PICS.autoRickshaw, line: "ride" },
  { role: "BUYER", icon: Search, title: "Buy a car or bike", text: "New or second-hand. A mechanic can inspect it before you pay.", pic: PICS.carLot, line: "market" },
  { role: "SELLER", icon: Tag, title: "Sell your vehicle", text: "List it in minutes and get offers from real buyers.", pic: PICS.keys, line: "market" },
  { role: "DRIVER", icon: Navigation, title: "Drive and earn", text: "Drive a car or bike, take rides near you, and cash out to your bank.", pic: PICS.nightCab, line: "earn" },
  { role: "VEHICLE_OWNER", icon: KeyRound, title: "Rent out a vehicle", text: "Own a car or bike? Rent it out or give it to a driver.", pic: PICS.suvRoad, line: "rent" },
  { role: "GARAGE_OWNER", icon: Wrench, title: "Run a garage", text: "Get repair bookings and breakdown calls from people near you.", pic: PICS.garage, line: "repair" },
] as const;

const FLOWS = {
  rider: { label: "I need a ride", icon: CarFront, steps: [
    [MapPin, "Say where", "Your location is found for you. Type or tap where you want to go."],
    [Wallet, "See the price", "The full fare shows before you book. It will not change."],
    [LocateFixed, "Watch it come", "Follow your driver live on the map until they reach you."],
    [Star, "Pay and rate", "Pay by card or UPI at the end, then rate your driver."],
  ] },
  driver: { label: "I want to drive", icon: Navigation, steps: [
    [BadgeCheck, "Sign up as a driver", "Add your licence. We check it, usually within a day."],
    [LocateFixed, "Go online", "Switch on location. Nearby ride requests appear on your map."],
    [Navigation, "Pick up and go", "See where the customer is, tap Navigate, and finish the trip."],
    [Wrench, "Find a mechanic", "Need a repair? See mechanics near you with distance and directions."],
  ] },
  buyer: { label: "Buy or sell", icon: Tag, steps: [
    [Search, "Search vehicles", "Filter by price, fuel, and new or second-hand. See which are near you."],
    [HandCoins, "Make an offer", "Type the price you want to pay. The seller says yes or no."],
    [ClipboardCheck, "Get it inspected", "A mechanic checks it and gives a score out of 10."],
    [ShieldCheck, "Pay safely", "Pay through RideX. Nothing is charged twice."],
  ] },
  garage: { label: "Garage owner", icon: Wrench, steps: [
    [Users, "Add your garage", "Put your location, services and prices on the map."],
    [LocateFixed, "Get found", "Drivers and riders near you can see you and ask for directions."],
    [ClipboardCheck, "Take bookings", "Accept repair jobs and breakdown calls, and track the work."],
    [Wallet, "Get paid", "Customers pay in the app when the work is done."],
  ] },
} as const;

const FEATURES = [
  { i: LocateFixed, t: "Live location", d: "See your driver coming, and drivers see where you wait." },
  { i: Wallet, t: "Price first", d: "The full fare is shown before you book." },
  { i: ClipboardCheck, t: "Checked before you buy", d: "A real mechanic inspects used vehicles." },
  { i: Mic, t: "Ask by voice", d: "Speak to the helper in Hindi, English and 12 more languages." },
];

/** Decorative sample of the live-ride screen, so visitors see what they will get. Not real data. */
function HeroMock() {
  return (
    <div aria-hidden className="relative mx-auto w-full max-w-[520px] lg:mx-0">
      <Photo pic={PICS.cityTaxi} eager sizes="(min-width:1024px) 520px, 100vw" position="center 62%" className="aspect-[4/4.4] rounded-5xl shadow-lift sm:aspect-[4/3.6] lg:aspect-[4/4.6]" />
      <div className="absolute inset-x-4 top-4 rounded-3xl bg-white p-4 shadow-lift sm:inset-x-6 sm:top-6">
        <p className="text-[11px] font-bold uppercase tracking-wide text-mute">Your route</p>
        <div className="mt-2 space-y-2 text-sm font-semibold">
          <p className="flex items-center gap-3"><span className="h-3.5 w-3.5 rounded-full border-[3px] border-white bg-earn ring-2 ring-earn/40" />MG Road, Bengaluru</p>
          <p className="flex items-center gap-3"><MapPin size={16} className="text-repair" />Koramangala, Bengaluru</p>
        </div>
      </div>
      <div className="absolute inset-x-4 bottom-4 rounded-3xl bg-white p-4 shadow-lift sm:inset-x-6 sm:bottom-6">
        <div className="flex items-center justify-between rounded-2xl bg-earn/10 px-3 py-2 text-sm font-bold"><span className="text-earn-ink">Your driver is arriving</span><span className="num text-earn-ink">3 min</span></div>
        <div className="mt-3 flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand font-bold text-white">D</span>
          <div className="min-w-0 flex-1"><p className="font-display font-extrabold">Divya <span className="ml-1 text-sm text-ride-ink"><Star size={13} className="inline -mt-0.5" fill="currentColor" aria-hidden /> 4.9</span></p><p className="text-xs text-mute">White Toyota Etios</p></div>
          <p className="num rounded-xl bg-concrete px-3 py-1.5 font-display text-sm font-extrabold tracking-wide">KA01 AB 1234</p>
        </div>
        <div className="mt-3 flex gap-2"><span className="flex h-11 flex-1 items-center justify-center gap-2 rounded-2xl bg-brand-soft text-sm font-bold text-brand"><Phone size={16} />Call</span><span className="flex h-11 flex-1 items-center justify-center gap-2 rounded-2xl bg-brand text-sm font-bold text-white"><MessageCircle size={16} />Chat</span></div>
      </div>
    </div>
  );
}

export function Landing() {
  const [flow, setFlow] = useState<keyof typeof FLOWS>("rider");
  const steps = FLOWS[flow].steps;
  return (
    <div className="min-h-screen" data-line="ride">
      <header className="sticky top-0 z-30 border-b border-white/70 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
          <Link to="/" aria-label="RideX home"><Logo dark /></Link>
          <nav aria-label="Sections" className="ml-8 hidden gap-6 text-sm font-bold text-mute md:flex">
            <a href="#who" className="hover:text-brand">What can I do?</a>
            <a href="#how" className="hover:text-brand">How it works</a>
            <Link to="/guide" className="hover:text-brand">Guide with pictures</Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/login" className="btn btn-ghost btn-sm">Sign in</Link>
            <Link to="/login?mode=register" className="btn btn-primary btn-sm">Get started</Link>
          </div>
        </div>
      </header>

      <section className="mx-auto grid max-w-7xl items-center gap-10 px-4 pb-12 pt-8 sm:px-6 sm:pt-12 lg:grid-cols-[1.05fr_1fr] lg:gap-14 lg:pb-20 lg:pt-16">
        <div>
          <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-white px-4 py-1.5 text-xs font-bold text-brand shadow-card sm:text-sm"><LocateFixed size={14} aria-hidden />Live location, fair prices, real mechanics</p>
          <h1 className="text-4xl leading-[1.04] sm:text-6xl">Rides, vehicles and repairs. <span className="text-brand">All in one place.</span></h1>
          <p className="mt-5 max-w-xl text-base text-mute sm:text-lg">Book a ride, buy or sell a car or bike, drive and earn, or find a mechanic near you.</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link to={join("RIDER")} className="btn btn-primary !px-7 !py-4 !text-base"><CarFront size={20} aria-hidden />Book a ride</Link>
            <Link to={join("DRIVER")} className="btn btn-ghost !px-7 !py-4 !text-base"><Navigation size={20} aria-hidden />Drive and earn</Link>
          </div>
          <p className="mt-5 text-sm text-mute">Already have an account? <Link to="/login" className="font-bold text-brand underline-offset-4 hover:underline">Sign in</Link></p>
          <dl className="mt-9 grid max-w-md grid-cols-3 gap-4">
            {[["6", "ways to use it"], ["14", "voice languages"], ["24/7", "breakdown help"]].map(([n, l]) => (
              <div key={l} className="rounded-3xl bg-white p-4 shadow-card"><dt className="num font-display text-2xl font-extrabold text-brand">{n}</dt><dd className="text-xs font-semibold text-mute">{l}</dd></div>
            ))}
          </dl>
        </div>
        <HeroMock />
      </section>

      <main>
        <section id="who" aria-labelledby="who-h" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-12 sm:px-6 sm:py-16">
          <h2 id="who-h" className="text-2xl sm:text-4xl">What do you want to do?</h2>
          <p className="mt-2 max-w-2xl text-mute">Pick one. We will make your account for it. You can add more later.</p>
          <ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {ROLES.map((r) => (
              <li key={r.role}>
                <Link to={join(r.role)} className="group block overflow-hidden rounded-4xl bg-white shadow-card transition hover:-translate-y-1 hover:shadow-lift">
                  <Photo pic={r.pic} sizes="(min-width:1024px) 380px, (min-width:640px) 45vw, 100vw" className="h-48">
                    <span className="absolute left-4 top-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-brand shadow-card"><r.icon size={21} aria-hidden /></span>
                  </Photo>
                  <div className="p-5">
                    <h3 className="text-lg">{r.title}</h3>
                    <p className="mt-1 text-sm text-mute">{r.text}</p>
                    <p className="mt-3 flex items-center gap-1.5 font-display text-sm font-extrabold text-brand">Continue <ArrowRight size={16} className="transition group-hover:translate-x-1" aria-hidden /></p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section id="how" aria-labelledby="how-h" className="scroll-mt-20 bg-white/70 py-12 sm:py-16">
          <div className="mx-auto max-w-7xl px-4 sm:px-6">
            <h2 id="how-h" className="text-2xl sm:text-4xl">How it works</h2>
            <div role="tablist" aria-label="Who are you?" className="no-scrollbar mt-6 flex gap-2 overflow-x-auto pb-2">
              {(Object.keys(FLOWS) as Array<keyof typeof FLOWS>).map((k) => { const F = FLOWS[k]; return (
                <button key={k} role="tab" aria-selected={flow === k} onClick={() => setFlow(k)} className={cn("chip shrink-0", flow === k && "is-active")}><F.icon size={16} aria-hidden />{F.label}</button>); })}
            </div>
            <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {steps.map(([Icon, t, d], n) => (
                <li key={t} className="rounded-4xl bg-white p-6 shadow-card">
                  <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft text-brand"><Icon size={24} aria-hidden /></span>
                  <p className="mt-4 font-display text-lg font-extrabold"><span className="num mr-1.5 text-brand">{n + 1}.</span>{t}</p>
                  <p className="mt-1 text-sm text-mute">{d}</p>
                </li>
              ))}
            </ol>
            <Link to="/guide" className="btn btn-ghost mt-6"><CircleHelp size={18} aria-hidden />See it with pictures · तस्वीरों में देखें</Link>
          </div>
        </section>

        <section aria-label="Why RideX" className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16">
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <li key={f.t} className="rounded-4xl bg-white p-6 shadow-card">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand text-white"><f.i size={22} aria-hidden /></span><p className="mt-4 font-display font-extrabold">{f.t}</p><p className="mt-1 text-sm text-mute">{f.d}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="px-4 pb-14 sm:px-6">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-5 rounded-5xl bg-gradient-to-br from-brand to-[#3B3FE8] p-7 text-white shadow-lift sm:p-12">
            <Bike size={40} aria-hidden />
            <div className="min-w-[14rem] flex-1"><h2 className="text-2xl sm:text-4xl">Ready? It takes a minute.</h2><p className="mt-1 text-white/80">Make an account, switch on your location, and go.</p></div>
            <Link to="/login?mode=register" className="btn !bg-white !px-7 !py-4 !text-brand hover:!bg-brand-soft">Create my account</Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/70 bg-white/70 px-4 py-6 text-center text-xs text-mute sm:px-6">
        <p>Photos from Unsplash: {Object.values(PICS).map((p, i) => (<span key={p.id}>{i > 0 && ", "}<a className="underline" href={p.page} target="_blank" rel="noreferrer noopener">{p.credit}</a></span>))}</p>
      </footer>
    </div>
  );
}

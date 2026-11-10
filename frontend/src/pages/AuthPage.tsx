import { FormEvent, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth, Role } from "@/store/auth";
import { errorMessage } from "@/lib/api";
import { Button, Field } from "@/components/ui";
import { CarFront, CircleHelp, KeyRound, Tag, Wrench } from "lucide-react";
import { Photo } from "@/components/Photo";
import { PICS } from "@/lib/images";
import { Logo } from "@/components/Shell";

const SIGNUP_ROLES: Array<{ id: Role; label: string; note: string }> = [
  { id: "RIDER", label: "Ride and rent", note: "Book rides, rent vehicles" },
  { id: "DRIVER", label: "Drive", note: "Take rides and earn" },
  { id: "VEHICLE_OWNER", label: "Own vehicles", note: "Rent out or assign to drivers" },
  { id: "SELLER", label: "Sell vehicles", note: "List second-hand vehicles" },
  { id: "BUYER", label: "Buy vehicles", note: "Make offers, book inspections" },
  { id: "GARAGE_OWNER", label: "Run a garage", note: "Take repair bookings" },
];

export function AuthPage() {
  const { login, register, status } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const wanted = SIGNUP_ROLES.find((r) => r.id === params.get("role"));
  const [mode, setMode] = useState<"login" | "register">(params.get("mode") === "register" || wanted ? "register" : "login");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [roles, setRoles] = useState<Role[]>(wanted ? [wanted.id] : ["RIDER"]);

  if (status === "authenticated") return <Navigate to="/home" replace />;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setErr("");
    try {
      if (mode === "login") await login(String(f.get("email")), String(f.get("password")));
      else await register({ email: String(f.get("email")), password: String(f.get("password")), fullName: String(f.get("fullName")), roles });
      nav("/home");
    } catch (e2) { setErr(errorMessage(e2)); } finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen bg-concrete lg:grid lg:grid-cols-[1.05fr_1fr]" data-line="ride">
      <Photo pic={PICS.cityTaxi} eager sizes="(min-width:1024px) 55vw, 100vw" position="center 65%" className="h-56 sm:h-72 lg:sticky lg:top-0 lg:h-screen">
        <div className="flex h-full flex-col justify-between p-6 text-white sm:p-10">
          <Link to="/" aria-label="RideX home"><Logo /></Link>
          <div className="hidden max-w-lg lg:block">
            <h1 className="text-5xl leading-[1.05]">One app for the whole journey.</h1>
            <p className="mt-4 text-lg text-white/80">Book a ride, rent a vehicle, buy or sell a used one, and get it fixed, all in one place.</p>
            <ul className="mt-6 flex flex-wrap gap-2">
              {[[CarFront, "Ride"], [KeyRound, "Rent"], [Tag, "Buy & sell"], [Wrench, "Repair"]].map(([I, l]) => { const Icon = I as typeof CarFront; return (
                <li key={String(l)} className="flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold backdrop-blur"><Icon size={16} aria-hidden />{String(l)}</li>); })}
            </ul>
          </div>
          <p className="text-2xl font-bold leading-tight lg:hidden">One app for the whole journey.</p>
        </div>
      </Photo>

      <section className="-mt-8 flex items-start justify-center px-4 pb-10 sm:px-8 lg:mt-0 lg:items-center lg:py-10">
        <form onSubmit={submit} className="relative w-full max-w-md space-y-4 rounded-5xl bg-white p-6 shadow-lift sm:p-8" aria-label={mode === "login" ? "Sign in" : "Create account"}>
          <div><h2 className="text-2xl sm:text-3xl">{mode === "login" ? "Welcome back" : "Create your account"}</h2>
            <p className="mt-1 text-sm text-mute">{mode === "login" ? "Sign in to continue." : wanted ? `You are signing up to: ${wanted.label.toLowerCase()}. You can add more later.` : "It takes a minute. You can change what you do later."}</p></div>
          {mode === "register" && (
            <Field label="Full name">{(id) => <input id={id} name="fullName" required minLength={2} autoComplete="name" />}</Field>
          )}
          <Field label="Email">{(id) => <input id={id} name="email" type="email" required autoComplete="email" inputMode="email" />}</Field>
          <Field label="Password" hint={mode === "register" ? "At least 8 characters with an uppercase letter, a lowercase letter and a number." : undefined}>
            {(id) => <input id={id} name="password" type="password" required autoComplete={mode === "login" ? "current-password" : "new-password"} />}
          </Field>

          {mode === "register" && (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-semibold">What will you do on RideX?</legend>
              {SIGNUP_ROLES.map((r) => (
                <label key={r.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 font-normal has-[:checked]:border-brand has-[:checked]:bg-brand-soft">
                  <input
                    type="checkbox" className="mt-1 h-4 w-4" checked={roles.includes(r.id)}
                    onChange={(e) => setRoles((cur) => (e.target.checked ? [...cur, r.id] : cur.filter((x) => x !== r.id)))}
                  />
                  <span><span className="block text-sm font-semibold">{r.label}</span><span className="text-xs text-mute">{r.note}</span></span>
                </label>
              ))}
            </fieldset>
          )}

          {err && <p role="alert" className="rounded-xl border border-repair/30 bg-repair/5 px-3.5 py-2.5 text-sm">{err}</p>}
          <Button type="submit" busy={busy} disabled={mode === "register" && roles.length === 0} className="w-full">
            {mode === "login" ? "Sign in" : "Create account"}
          </Button>
          <p className="text-center text-sm">
            {mode === "login" ? "New to RideX?" : "Already have an account?"}{" "}
            <button type="button" className="font-bold underline" onClick={() => { setMode(mode === "login" ? "register" : "login"); setErr(""); }}>
              {mode === "login" ? "Create an account" : "Sign in"}
            </button>
          </p>
          <a href="/guide" className="flex items-center gap-3 rounded-2xl bg-brand-soft px-4 py-3 text-sm font-semibold text-ink hover:bg-brand-mid">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-white"><CircleHelp size={20} aria-hidden /></span>
            <span>New here? See how it works, with pictures<span className="block font-normal text-mute">पहली बार? तस्वीरों में देखें</span></span>
          </a>
          {mode === "login" && <p className="text-xs text-mute">Trying the demo? <code>rider@ridex.dev</code>, <code>driver@ridex.dev</code>, <code>owner@ridex.dev</code>, <code>garage@ridex.dev</code> or <code>admin@ridex.dev</code>, password <code>Passw0rd123</code>.</p>}
        </form>
      </section>
    </div>
  );
}

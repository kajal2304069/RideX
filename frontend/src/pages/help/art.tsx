import { ComponentType } from "react";
import { Bell, CalendarDays, CarFront, CheckCheck, CircleHelp, ClipboardCheck, CreditCard, HandCoins, Hourglass, IndianRupee, KeyRound, LifeBuoy, LucideProps, MapPin, Navigation, Power, Receipt, Search, ShieldCheck, Star, UserPlus, Wallet, Wrench } from "lucide-react";

/**
 * One clear icon per step, big and high-contrast, in the colour of the guide it belongs to. (These replace the old
 * hand-drawn cartoons: icons read faster and stay sharp on every screen.)
 */
const ICONS: Record<string, [ComponentType<LucideProps>, string]> = {
  accept: [CheckCheck, "Accept the request"], bell: [Bell, "Notifications bell"], calendar: [CalendarDays, "Choose a date and time"], carComing: [Navigation, "A car coming to you on the map"],
  carKey: [KeyRound, "A car key"], chooseVehicle: [CarFront, "Choose bike, auto or car"], deposit: [ShieldCheck, "A safe deposit"], earn: [IndianRupee, "Money earned"],
  garage: [Wrench, "A garage"], help: [CircleHelp, "Help"], inspect: [ClipboardCheck, "An inspection checklist"], offer: [HandCoins, "Make an offer"],
  online: [Power, "Go online"], pay: [CreditCard, "Pay"], pickPins: [MapPin, "Pins on the map"], rate: [Star, "Give stars"], search: [Search, "Search"],
  seePrice: [Receipt, "The price"], signup: [UserPlus, "Create an account"], sos: [LifeBuoy, "Get help on the road"], waiting: [Hourglass, "Waiting for a driver"], wallet: [Wallet, "Your wallet"],
};

function StepArt({ id }: { id: string }) {
  const [Icon, label] = ICONS[id];
  return (
    <div role="img" aria-label={label} className="flex h-36 items-center justify-center rounded-2xl bg-brand-soft sm:h-40">
      <span className="flex h-20 w-20 items-center justify-center rounded-full bg-brand text-white shadow-card"><Icon size={38} strokeWidth={2} aria-hidden /></span>
    </div>
  );
}

export const ART: Record<string, () => JSX.Element> = Object.fromEntries(Object.keys(ICONS).map((k) => [k, () => <StepArt id={k} />]));

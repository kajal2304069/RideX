import { cn } from "@/lib/format";

/**
 * The ride as a transit line: each state is a station, the line fills to wherever the ride is now.
 * This is the one place the interface leans on the metaphor, because a ride really is a sequence of stops.
 */
export const RIDE_STATIONS = [
  { id: "SEARCHING_DRIVER", label: "Finding driver" },
  { id: "DRIVER_ASSIGNED", label: "Driver assigned" },
  { id: "DRIVER_ARRIVING", label: "On the way" },
  { id: "DRIVER_ARRIVED", label: "Arrived" },
  { id: "TRIP_STARTED", label: "On trip" },
  { id: "TRIP_COMPLETED", label: "Reached" },
  { id: "PAYMENT_COMPLETED", label: "Paid" },
] as const;

export function RideLine({ status }: { status: string }) {
  const normalized = status === "REQUESTED" ? "SEARCHING_DRIVER" : status;
  const idx = RIDE_STATIONS.findIndex((s) => s.id === normalized);
  const cancelled = status.startsWith("CANCELLED");
  return (
    <ol className="flex w-full" aria-label="Ride progress">
      {RIDE_STATIONS.map((s, i) => {
        const done = !cancelled && i < idx;
        const here = !cancelled && i === idx;
        return (
          <li key={s.id} className="relative flex-1 pt-6 text-center" aria-current={here ? "step" : undefined}>
            {i > 0 && <span className={cn("absolute left-[-50%] right-[50%] top-[9px] h-1.5", done || here ? "bg-brand" : "bg-rule")} aria-hidden />}
            <span
              className={cn(
                "absolute left-1/2 top-0 z-10 h-6 w-6 -translate-x-1/2 rounded-full border-[3px] border-brand",
                here ? "bg-brand ring-4 ring-brand/25" : done ? "bg-brand" : "bg-white"
              )}
              aria-hidden
            />
            <span className={cn("hidden text-[11px] leading-tight sm:block", here ? "font-bold" : "text-mute")}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

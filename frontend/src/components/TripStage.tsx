import { ReactNode } from "react";
import { cn } from "@/lib/format";

/**
 * The full-screen map layout used for booking and live tracking.
 *   phone:         map fills the screen; route card floats on top; a white sheet rises from the bottom
 *   iPad / laptop: the map sits in a big rounded card; the route card and sheet float on its left side
 * The round buttons (share, safety, my location): left and right above the sheet on a phone, stacked bottom-right on larger screens.
 */
export function TripStage({ map, top, sheet, fabsLeft, fabsRight, sheetClass }: { map: ReactNode; top: ReactNode; sheet: ReactNode; fabsLeft?: ReactNode; fabsRight?: ReactNode; sheetClass?: string }) {
  const hasFabs = !!(fabsLeft || fabsRight);
  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-concrete md:h-[calc(100dvh-2.5rem)] md:rounded-5xl md:shadow-lift lg:h-[calc(100dvh-3rem)]">
      <div className="absolute inset-0">{map}</div>

      <div className="pointer-events-none absolute inset-x-3 top-3 z-[1000] md:inset-x-auto md:left-4 md:top-4 md:w-[400px]">
        <div className="pointer-events-auto">{top}</div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1000] flex flex-col md:inset-x-auto md:bottom-4 md:left-4 md:w-[400px]">
        {hasFabs && <div className="pointer-events-none flex items-end justify-between gap-3 px-3 pb-3 md:hidden"><div className="pointer-events-auto flex flex-col gap-3">{fabsLeft}</div><div className="pointer-events-auto flex flex-col gap-3">{fabsRight}</div></div>}
        <div className={cn("pointer-events-auto max-h-[60dvh] overflow-y-auto rounded-t-[32px] bg-white px-5 pb-6 pt-3 shadow-sheet md:max-h-[calc(100dvh-15rem)] md:rounded-4xl md:pb-5", sheetClass)}>
          <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-rule md:hidden" aria-hidden />
          {sheet}
        </div>
      </div>

      {hasFabs && <div className="absolute bottom-24 right-4 z-[1000] hidden flex-col gap-3 md:flex">{fabsLeft}{fabsRight}</div>}
    </div>
  );
}

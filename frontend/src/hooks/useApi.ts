import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get } from "@/lib/api";
import { errorMessage } from "@/lib/api";
import { toast } from "@/store/toast";
import { useEffect, useState } from "react";
import { CITY_CENTER } from "@/components/MapView";

export interface VehicleType { id: string; code: string; name: string; category: "RIDE" | "RENTAL" | "BOTH"; baseFare: number; perKmRate: number; perMinRate: number }

export const useVehicleTypes = () =>
  useQuery({ queryKey: ["vehicle-types"], queryFn: async () => (await get<{ vehicleTypes: VehicleType[] }>("/vehicles/types")).vehicleTypes, staleTime: 10 * 60_000 });

/** A mutation that reports failures as a toast and refreshes the named query keys on success. */
export function useAction<TArgs, TResult>(fn: (a: TArgs) => Promise<TResult>, opts: { ok?: string; invalidate?: string[][]; onDone?: (r: TResult) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts.ok) toast.ok(opts.ok);
      opts.invalidate?.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      opts.onDone?.(r);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

/** The browser's position, falling back to the city centre (so the app is usable without permission). */
export function useMyLocation() {
  const [pos, setPos] = useState<{ lat: number; lng: number }>(CITY_CENTER);
  const [real, setReal] = useState(false);
  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (p) => { setPos({ lat: p.coords.latitude, lng: p.coords.longitude }); setReal(true); },
      () => {},
      { timeout: 4000, maximumAge: 60_000 }
    );
  }, []);
  return { pos, real };
}

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get } from "@/lib/api";
import { dt, inr, km } from "@/lib/format";
import { Button, Empty, Loading, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { RateRide } from "@/components/RateRide";
import { Ride } from "./rideTypes";

export function RideHistory() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["ride", "history"], queryFn: async () => (await get<{ rides: Ride[] }>("/rides/history")).rides });
  const [rate, setRate] = useState<string | null>(null);
  return (
    <div data-line="ride">
      <PageHeader title="Trips" sub="Your past rides, newest first." />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty title="No trips yet">Book your first ride and it will show up here.</Empty> : (
        <Panel>
          <ul>{q.data.map((r) => (
            <li key={r.id} className="rule-row">
              <div className="min-w-0">
                <p className="font-bold">{r.pickup.address} → {r.dropoff.address}</p>
                <p className="text-sm text-mute">{dt(r.requestedAt)} · {km(r.distanceMeters)}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="num font-bold">{r.fare ? inr(r.fare.totalFare) : ""}</span>
                <StatusBadge status={r.status} />
                {r.status === "PAYMENT_COMPLETED" && <Button size="sm" variant="ghost" onClick={() => setRate(r.id)}>Rate</Button>}
              </div>
            </li>
          ))}</ul>
        </Panel>
      )}
      {rate && <RateRide rideId={rate} who="your driver" onClose={() => setRate(null)} onRated={() => qc.invalidateQueries({ queryKey: ["ride"] })} />}
    </div>
  );
}

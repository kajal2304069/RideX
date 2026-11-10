import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import { useAuth } from "@/store/auth";
import { dt, humanize, inr, newKey } from "@/lib/format";
import { Button, Empty, Loading, PageHeader, Panel, Stat, StatusBadge, Tabs } from "@/components/ui";
import { useAction } from "@/hooks/useApi";

interface Balance { earned: number; withdrawn: number; available: number }
interface OwnerSummary { rideShareEarnings: number; rentalRevenue: number; grossEarnings: number; maintenanceCost: number; netEarnings: number; rideCount: number; rentalCount: number; balance: Balance;
  vehicles: Array<{ vehicleId: string; title: string; registrationNumber: string; rideShareEarnings: number; rentalRevenue: number; maintenanceCost: number; netEarnings: number }> }
interface DriverSummary { rideFares: number; bonuses: number; adjustments: number; totalEarnings: number; rideCount: number; balance: Balance }
interface Payout { id: string; kind: string; amount: number; status: string; createdAt: string; failureReason: string | null }

export function Earnings() {
  const has = useAuth((s) => s.has);
  const tabs = [...(has("VEHICLE_OWNER") ? [{ id: "owner" as const, label: "As an owner" }] : []), ...(has("DRIVER") ? [{ id: "driver" as const, label: "As a driver" }] : [])];
  const [tab, setTab] = useState<"owner" | "driver">(tabs[0]?.id ?? "owner");
  return (
    <div data-line="earn">
      <PageHeader title="Earnings" sub="What your vehicles and your driving have earned, and how to withdraw it." />
      {tabs.length > 1 && <div className="mb-5"><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>}
      {tab === "owner" && has("VEHICLE_OWNER") ? <OwnerView /> : <DriverView />}
      <Wallet />
    </div>
  );
}

function OwnerView() {
  const q = useQuery({ queryKey: ["earnings", "owner"], queryFn: () => get<OwnerSummary>("/earnings/owner/summary") });
  if (q.isLoading) return <Loading />;
  const d = q.data!;
  return (
    <div className="space-y-5">
      <Panel>
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Stat label="Ride earnings" value={inr(d.rideShareEarnings)} note={`${d.rideCount} paid rides`} />
          <Stat label="Rental revenue" value={inr(d.rentalRevenue)} note={`${d.rentalCount} rentals`} />
          <Stat label="Maintenance" value={inr(d.maintenanceCost)} />
          <Stat label="Net earnings" value={inr(d.netEarnings)} />
        </div>
      </Panel>
      <Panel title="By vehicle">
        {!d.vehicles.length ? <Empty title="No vehicles yet" /> : (
          <div className="overflow-x-auto"><table>
            <thead><tr><th>Vehicle</th><th className="text-right">Rides</th><th className="text-right">Rentals</th><th className="text-right">Maintenance</th><th className="text-right">Net</th></tr></thead>
            <tbody>{d.vehicles.map((v) => (
              <tr key={v.vehicleId}><td><span className="font-bold">{v.title}</span><br /><span className="text-xs text-mute">{v.registrationNumber}</span></td>
                <td className="num text-right">{inr(v.rideShareEarnings)}</td><td className="num text-right">{inr(v.rentalRevenue)}</td><td className="num text-right">{inr(v.maintenanceCost)}</td><td className="num text-right font-bold">{inr(v.netEarnings)}</td></tr>
            ))}</tbody></table></div>
        )}
      </Panel>
      <Entries kind="owner" />
    </div>
  );
}

function DriverView() {
  const q = useQuery({ queryKey: ["earnings", "driver"], queryFn: () => get<DriverSummary>("/earnings/driver/summary") });
  if (q.isLoading) return <Loading />;
  const d = q.data!;
  return (
    <div className="space-y-5">
      <Panel><div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
        <Stat label="Ride earnings" value={inr(d.rideFares)} note={`${d.rideCount} trips`} /><Stat label="Bonuses" value={inr(d.bonuses)} />
        <Stat label="Adjustments" value={inr(d.adjustments)} /><Stat label="Total" value={inr(d.totalEarnings)} />
      </div></Panel>
      <Entries kind="driver" />
    </div>
  );
}

function Entries({ kind }: { kind: "owner" | "driver" }) {
  const q = useQuery({ queryKey: ["earnings", kind, "entries"], queryFn: async () => (await get<{ entries: Array<{ id: string; amount: number; createdAt: string; sourceType?: string; type?: string }> }>(`/earnings/${kind}/entries`, { limit: 20 })).entries });
  return (
    <Panel title="Recent earnings">
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty title="Nothing earned yet">Earnings appear here after a rider pays for a trip or a rental is returned.</Empty> : (
        <ul>{q.data.map((e) => <li key={e.id} className="rule-row"><span>{humanize(e.sourceType ?? e.type ?? "")}</span><span className="text-sm text-mute">{dt(e.createdAt)}</span><span className="num font-bold">{inr(e.amount)}</span></li>)}</ul>
      )}
    </Panel>
  );
}

function Wallet() {
  const bal = useQuery({ queryKey: ["earnings", "balance"], queryFn: async () => (await get<{ balance: Balance }>("/earnings/balance")).balance });
  const payouts = useQuery({ queryKey: ["earnings", "payouts"], queryFn: async () => (await get<{ payouts: Payout[] }>("/earnings/payouts")).payouts });
  const [amount, setAmount] = useState("");
  const [key, setKey] = useState(newKey);
  const withdraw = useAction(() => post<{ payout: Payout }>("/earnings/payouts", amount ? { amount: Number(amount) } : {}, { "Idempotency-Key": key }),
    { ok: "Withdrawal sent", invalidate: [["earnings"]], onDone: () => { setAmount(""); setKey(newKey()); } });
  return (
    <div className="mt-5 grid gap-5 lg:grid-cols-2">
      <Panel title="Withdraw">
        <div className="mb-4 grid grid-cols-3 gap-3">
          <Stat label="Available" value={inr(bal.data?.available)} /><Stat label="Earned" value={inr(bal.data?.earned)} /><Stat label="Withdrawn" value={inr(bal.data?.withdrawn)} />
        </div>
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); withdraw.mutate(undefined); }}>
          <div className="flex-1"><label htmlFor="wd">Amount (₹)</label><input id="wd" type="number" min={1} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Leave empty to withdraw everything" /></div>
          <Button type="submit" busy={withdraw.isPending} disabled={!bal.data?.available}>Withdraw</Button>
        </form>
      </Panel>
      <Panel title="Payouts">
        {!payouts.data?.length ? <Empty title="No withdrawals yet" /> : (
          <ul>{payouts.data.map((p) => <li key={p.id} className="rule-row"><span>{humanize(p.kind)}<br /><span className="text-xs text-mute">{dt(p.createdAt)}</span></span><span className="num font-bold">{inr(p.amount)}</span><StatusBadge status={p.status} /></li>)}</ul>
        )}
      </Panel>
    </div>
  );
}

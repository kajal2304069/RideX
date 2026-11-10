import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/api";
import { dt, humanize, inr } from "@/lib/format";
import { Empty, Loading, PageHeader, Panel, StatusBadge } from "@/components/ui";

interface Payment { id: string; payableType: string; amount: number; currency: string; status: string; createdAt: string; failureReason: string | null }

export function Payments() {
  const q = useQuery({ queryKey: ["payments"], queryFn: async () => (await get<{ payments: Payment[] }>("/payments")).payments });
  return (
    <div data-line="ride">
      <PageHeader title="Payments" sub="Everything you've paid for across rides, rentals, purchases and repairs." />
      {q.isLoading ? <Loading /> : !q.data?.length ? <Empty title="No payments yet">When you pay for a ride, rental, vehicle or repair, it shows up here.</Empty> : (
        <Panel><div className="overflow-x-auto"><table>
          <thead><tr><th>Date</th><th>For</th><th className="text-right">Amount</th><th>Status</th></tr></thead>
          <tbody>{q.data.map((p) => (
            <tr key={p.id}><td>{dt(p.createdAt)}</td><td>{humanize(p.payableType)}</td><td className="num text-right">{inr(p.amount)}</td>
              <td><StatusBadge status={p.status} />{p.failureReason && <span className="ml-2 text-xs text-mute">{humanize(p.failureReason)}</span>}</td></tr>
          ))}</tbody></table></div></Panel>
      )}
    </div>
  );
}

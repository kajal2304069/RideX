import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { get, post } from "@/lib/api";
import { dt, inr } from "@/lib/format";
import { Empty, Loading, PageHeader, Panel, StatusBadge, Button } from "@/components/ui";
import { useAction } from "@/hooks/useApi";
import { Listing, Offer } from "./marketTypes";

interface Inspection { id: string; listingId: string; status: string; scheduledAt: string; overallScore?: number | null; flags?: string[]; report?: unknown }

export function BuyActivity() {
  const offers = useQuery({ queryKey: ["offers", "mine"], queryFn: async () => (await get<{ offers: Offer[] }>("/marketplace/offers/mine")).offers });
  const favs = useQuery({ queryKey: ["favorites"], queryFn: async () => (await get<{ listings: Listing[] }>("/marketplace/listings/favorites")).listings });
  const insp = useQuery({ queryKey: ["inspections", "mine"], queryFn: async () => (await get<{ inspections: Inspection[] }>("/marketplace/inspections/mine")).inspections });
  const withdraw = useAction((id: string) => post(`/marketplace/offers/${id}/withdraw`), { ok: "Offer withdrawn", invalidate: [["offers"]] });
  const cancel = useAction((id: string) => post(`/marketplace/inspections/${id}/cancel`), { ok: "Inspection cancelled", invalidate: [["inspections"]] });
  return (
    <div data-line="market">
      <PageHeader title="My buying activity" sub="Offers you've made, inspections you've booked and vehicles you've saved." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Offers">
          {offers.isLoading ? <Loading /> : !offers.data?.length ? <Empty title="No offers yet" /> : (
            <ul className="divide-y divide-rule">{offers.data.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 py-2">
                <div><Link to={`/buy/listings/${o.listingId}`} className="font-semibold underline">{o.listing?.brand ? `${o.listing.brand} ${o.listing.model}` : "View listing"}</Link><p className="num text-sm text-mute">{inr(o.amount)} · {dt(o.createdAt)}</p></div>
                <div className="flex items-center gap-2"><StatusBadge status={o.status} />{o.status === "PENDING" && <Button size="sm" variant="ghost" onClick={() => withdraw.mutate(o.id)}>Withdraw</Button>}</div>
              </li>))}</ul>
          )}
        </Panel>
        <Panel title="Inspections">
          {insp.isLoading ? <Loading /> : !insp.data?.length ? <Empty title="No inspections booked" /> : (
            <ul className="divide-y divide-rule">{insp.data.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 py-2">
                <div><Link to={`/buy/listings/${i.listingId}`} className="font-semibold underline">Listing</Link><p className="text-sm text-mute">{dt(i.scheduledAt)}{i.overallScore != null && ` · score ${i.overallScore}/10`}</p>{i.flags?.length ? <p className="text-xs text-repair-ink">{i.flags.join(", ")}</p> : null}</div>
                <div className="flex items-center gap-2"><StatusBadge status={i.status} />{["REQUESTED", "ASSIGNED"].includes(i.status) && <Button size="sm" variant="ghost" onClick={() => cancel.mutate(i.id)}>Cancel</Button>}</div>
              </li>))}</ul>
          )}
        </Panel>
        <Panel title="Saved vehicles" className="lg:col-span-2">
          {favs.isLoading ? <Loading /> : !favs.data?.length ? <Empty title="Nothing saved" /> : (
            <ul className="grid gap-2 sm:grid-cols-2">{favs.data.map((l) => <li key={l.id} className="rule-row"><Link to={`/buy/listings/${l.id}`} className="underline">{l.year} {l.brand} {l.model}</Link> <span className="num text-mute">{inr(l.price)}</span></li>)}</ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import { dt, inr, newKey, toLocalInput, humanize } from "@/lib/format";
import { Button, ErrorNote, Field, Loading, PageHeader, Panel, Stat } from "@/components/ui";
import { MapView } from "@/components/MapView";
import { PayModal } from "@/components/PayModal";
import { useAction } from "@/hooks/useApi";
import { errorMessage } from "@/lib/api";
import { Booking, Quote, RentalListing } from "./rentTypes";

export function RentDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const l = useQuery({ queryKey: ["rental", id], queryFn: async () => (await get<{ listing: RentalListing }>(`/rentals/listings/${id}`)).listing });
  const [start, setStart] = useState(() => toLocalInput(new Date(Date.now() + 2 * 3600_000)));
  const [end, setEnd] = useState(() => toLocalInput(new Date(Date.now() + 8 * 3600_000)));
  const [key, setKey] = useState(newKey);
  const [booking, setBooking] = useState<Booking | null>(null);

  const range = useMemo(() => ({ startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() }), [start, end]);
  const valid = !Number.isNaN(Date.parse(start)) && !Number.isNaN(Date.parse(end)) && new Date(end) > new Date(start);
  const quote = useQuery({ queryKey: ["quote", id, range], enabled: valid, retry: false, queryFn: () => get<{ quote: Quote }>(`/rentals/listings/${id}/quote`, range).then((r) => r.quote) });
  const book = useAction(() => post<{ booking: Booking }>(`/rentals/listings/${id}/bookings`, { ...range, idempotencyKey: key }), { ok: "Vehicle held for 15 minutes. Pay to confirm.", onDone: (r) => { setBooking(r.booking); setKey(newKey()); } });

  if (l.isLoading) return <Loading />;
  if (!l.data) return <ErrorNote error={l.error ?? new Error("Listing not found")} />;
  const v = l.data;

  return (
    <div data-line="rent">
      <PageHeader title={`${v.year} ${v.brand} ${v.model}`} sub={`${humanize(v.fuelType)} · ${humanize(v.transmission)} · listed by ${v.ownerName}`} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-5">
          <Panel>
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Per hour" value={v.hourlyPrice != null ? inr(v.hourlyPrice) : "–"} />
              <Stat label="Per day" value={v.dailyPrice != null ? inr(v.dailyPrice) : "–"} />
              <Stat label="Deposit (refundable)" value={inr(v.securityDeposit)} />
            </div>
          </Panel>
          <Panel title="Pickup"><p className="mb-3">{v.location.address ?? "See map"}</p><MapView height={280} markers={[{ lat: v.location.lat, lng: v.location.lng, icon: "car" }]} /></Panel>
          {v.rules && <Panel title="Owner's rules"><p className="whitespace-pre-line">{v.rules}</p></Panel>}
        </div>

        <Panel title="Book this vehicle" className="lg:sticky lg:top-4 lg:self-start">
          <div className="space-y-3">
            <Field label="Pickup">{(i) => <input id={i} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
            <Field label="Return">{(i) => <input id={i} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />}</Field>
            {!valid && <p className="text-sm text-repair-ink">Return must be after pickup.</p>}
            {quote.isLoading && <Loading label="Pricing" />}
            {quote.error && <ErrorNote error={new Error(errorMessage(quote.error))} />}
            {quote.data && (
              <div className="space-y-2 border-t border-rule pt-3 text-sm">
                <div className="num flex justify-between"><span className="text-mute">Rent ({quote.data.billedHours} h billed)</span><strong>{inr(quote.data.rentAmount)}</strong></div>
                <div className="num flex justify-between"><span className="text-mute">Refundable deposit</span><strong>{inr(quote.data.depositAmount)}</strong></div>
                <div className="num flex justify-between border-t border-rule pt-2 text-base"><span>Pay now</span><strong>{inr(quote.data.totalDue)}</strong></div>
                {!quote.data.available && <p className="rounded-2xl bg-repair/10 px-4 py-3 font-semibold">Already booked for part of this time. Pick different times.</p>}
                <p className="text-xs text-mute">Late returns are charged 1.5× the hourly rate from the deposit after a 15-minute grace period.</p>
              </div>
            )}
            <Button className="w-full" disabled={!quote.data?.available} busy={book.isPending} onClick={() => book.mutate(undefined)}>Reserve and pay</Button>
          </div>
        </Panel>
      </div>
      {booking && <PayModal type="RENTAL" id={booking.id} amount={booking.totalDue} title="Pay to confirm your rental" onClose={() => nav("/rent/bookings")} onPaid={() => nav("/rent/bookings")} />}
      <p className="mt-4 text-xs text-mute">{dt(new Date())}</p>
    </div>
  );
}

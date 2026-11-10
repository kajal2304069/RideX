# RideX — Phase 15: Vehicle marketplace

## 1. What we built

A second-hand vehicle marketplace where **one vehicle can be sold to exactly one buyer, once**, however many
buyers, tabs, retries and timers are racing.

- **Listings** (SELLER): create, edit, delist/relist, up to 10 https images, public browse and detail.
- **Search**: text (trigram), brand, price/year/mileage ranges, condition, fuel, transmission, radius (PostGIS);
  sort by newest, price, distance; **keyset pagination**.
- **Offers** (BUYER): 50%–100% of asking price, one pending offer per buyer per listing. The seller accepts one,
  which **reserves** the listing and rejects the rest.
- **Sale**: the buyer pays the *offer amount* through the Phase 12 payment system (new `MARKETPLACE` payable);
  success marks the listing `SOLD`.
- **Expiry**: an accepted offer must be paid within `OFFER_ACCEPTANCE_TTL_MS` (default 48 h) or it expires and the
  listing reopens (delayed BullMQ job + inline enforcement).
- **Inspections**: a buyer books a slot, a MECHANIC files a structured report; the **server** derives the score
  and red flags.
- **Favourites**, seller offer inbox, buyer "my offers", mechanic "open inspections".
- Notifications: OFFER_RECEIVED / ACCEPTED / REJECTED / EXPIRED, INSPECTION_SCHEDULED / COMPLETED, LISTING_SOLD.

## 2. Architecture

```
routes → controllers → services → repositories          (modules/marketplace)
   listings.service   offers.service   inspections.service

payments ──resolver──▶ offers.service.completeSale()    payments → marketplace (one-way)
offers.service ──▶ marketplaceQueue (delayed expire-offer job) ──▶ marketplaceWorker ──▶ expireIfDue()
```

Offer state machine:

```
PENDING ──accept──▶ ACCEPTED ──pay──▶ (listing SOLD)
   │ │                  └──TTL──▶ EXPIRED   (listing reopens)
   │ └──withdraw (buyer) ▶ WITHDRAWN
   └──reject (seller, or auto when another is accepted) ▶ REJECTED
```

An ACCEPTED offer cannot be withdrawn: it is a commitment that lapses on its own.

## 3. Database changes (migration `1725000015_marketplace_integrity`)

| Change | Guarantee |
|---|---|
| `UNIQUE (listing_id) WHERE status='ACCEPTED'` | at most one reserved buyer per listing |
| `UNIQUE (listing_id, buyer_id) WHERE status='PENDING'` | no duplicate pending offers |
| `UNIQUE (buyer_id, listing_id) WHERE inspection SCHEDULED` | one live booking per buyer/listing |
| `UNIQUE (listing_id, position)`, `CHECK position 0–9` | ≤10 images, no slot reuse |
| CHECKs: offer > 0, price > 0, year 1950–2100, mileage ≥ 0, owners ≥ 1 | bad data cannot be stored |
| `offer_status` += `EXPIRED`, `vehicle_offers.accepted_at`, `vehicle_inspections.inspector_id` | expiry + audit |
| `pg_trgm` GIN on `(brand \|\| ' ' \|\| model)` | fast substring search |
| Partial indexes on `status='ACTIVE'` for `created_at` and `price` | fast browse |

## 4. API (`/api/marketplace`)

| Method | Path | Who |
|---|---|---|
| GET | `/listings`, `/listings/:id` | public |
| POST/PATCH | `/listings`, `/listings/:id` | SELLER (owner) |
| POST | `/listings/:id/delist`, `/relist` | SELLER |
| POST/DELETE | `/listings/:id/images[/:imageId]` | SELLER |
| PUT/DELETE | `/listings/:id/favorite` | any user (idempotent) |
| POST/GET | `/listings/:id/offers` | BUYER makes / SELLER lists |
| GET | `/offers/mine` | BUYER |
| POST | `/offers/:id/accept`, `/reject` | SELLER · `/withdraw` BUYER |
| POST | `/payments` with `payableType: MARKETPLACE`, `payableId: <offerId>` | the buyer |
| POST/GET | `/listings/:id/inspections` | BUYER schedules / SELLER lists |
| GET | `/inspections/mine`, `/open`, `/:id` | BUYER / MECHANIC / parties + admin |
| POST | `/inspections/:id/report` | MECHANIC (not buyer/seller) · `/cancel` BUYER |

Codes: `400` validation / business rule, `404` missing **or not yours**, `409` state conflict or lost race.
Search cursor: `?cursor=` is an opaque base64url token; the response includes `nextCursor`.

## 5. How the guarantees work

**Accept (the reservation).** One transaction locks the listing row (`SELECT … FOR UPDATE`), requires ACTIVE,
flips the offer `PENDING→ACCEPTED`, rejects all other PENDING offers. Two simultaneous accepts serialise on the
row lock; the loser sees a non-PENDING offer and gets 409. The partial unique index is the backstop.

**Accept vs delist.** `delistIfUnreserved` takes the *same* row lock, so exactly one wins and the end state is
consistent with the winner (tested over repeated rounds).

**Payment vs expiry (the interesting race).** Both take `lock:payment:MARKETPLACE:<offerId>`. The timer additionally:
re-reads under the lock, applies a 5 s grace window for early timers, and **skips if a live payment exists**
(a PROCESSING payment must finish, otherwise we could expire an offer whose card is being charged). The payment
resolver also enforces the deadline inline, so a lost job cannot let a stale offer be paid. Invariant tested:
never `SUCCESS` payment with `EXPIRED` offer, never `SOLD` with `EXPIRED`.
The resolver expires inline and does **not** call the locking path (it already holds that lock — self-deadlock).

**Keyset pagination.** Cursor = `{sort value, id}`; query `WHERE (sort, id) < ($s, $id) ORDER BY sort, id LIMIT n+1`.
Sort value is selected as text so microsecond timestamps survive JSON. No skips or repeats under concurrent
inserts (OFFSET would shift pages).

**Server-derived inspection result.** Overall score = mean of six 1–10 scores, one decimal; flags:
`ACCIDENT_HISTORY`, `DOCUMENTS_NOT_VERIFIED`, `<PART>_POOR` for score ≤ 3. The strict schema rejects
client-sent `overallScore`/`flags`. A report cannot be filed earlier than slot − 1 h, and the buyer/seller
cannot inspect their own deal. `UPDATE … WHERE status='SCHEDULED'` makes two mechanics a 1×200 / 1×409.

**Image slots.** The free slot is chosen in SQL. Two concurrent adds can choose the same slot; the unique index
rejects one (23505). With no explicit position the service **retries** (up to 12×); an explicit taken position is
a real 409. Found by reasoning, confirmed by a failing concurrency test with the retry disabled.

**Money.** Integer minor units; the charge is the server-read offer amount, never client input.

## 6. Known gaps

- No escrow or ownership transfer paperwork: `SOLD` is a status, not a legal transfer.
- No payout to the seller yet (Phase 17 earnings covers rides/rentals, not marketplace commission).
- Images are URLs (https only), not uploads; no virus/size scanning.
- Inspections have no mechanic assignment/claiming; any MECHANIC may file for an open slot (first wins).
- A sale refunded by an admin does not reopen the listing.
- Distance sort/filter uses geography on the listing point only; no address geocoding.

## 7. Test cases (marketplace: 55 + 26 + 13 + 8 + 5)

- **Listings/search (55):** create/validation/DB CHECKs, visibility, edit/delist/relist, images, favourites, every
  filter and sort, `near`, pagination (no skip/repeat, tie-break, identical timestamps, concurrent insert, bad
  cursors), index-usability with `enable_seqscan=off`.
- **Offers/sale/expiry (26):** 50% boundary, role/ownership, one pending, reserved flag, accept side-effects, delayed
  job scheduled with the TTL, payment charges offer amount, declined card retry, sold listing frozen, replay,
  expiry (due, not due, idempotent, real worker, grace window, inline in payment, in-flight payment, lazy clear).
- **Inspections (13):** schedule rules, one-per-buyer, report timing, server-derived score/flags, strict schema,
  role and conflict-of-interest, visibility matrix, cancel rules.
- **Concurrency (8):** 6 simultaneous accepts, duplicate accept, accept vs delist, 8 identical offers,
  10 simultaneous payments, payment vs expiry, 3 mechanics, 12 concurrent image adds.
- **Unit (5):** `summarizeReport`, `MIN_OFFER_RATIO`.
- **Mutation checks:** dropping `vehicle_offers_one_accepted_per_listing` fails the DB-guarantee test; disabling
  the image retry fails the image concurrency test. Both restored.

## 8. Interview questions

**Why is "one buyer wins" enforced in three places?** App check = fast path and nice errors; row lock = ordering
of accept vs delist vs new offers; partial unique index = the guarantee if either is bypassed.

**Why lock the listing row instead of using Redis here?** The decision involves several rows in one
transaction (listing, offer, siblings); a row lock is atomic with them and has no TTL to lose. Redis is used where
the critical section spans a provider call (payment).

**Why can payment and expiry both claim the offer?** They don't: same Redis lock, plus the expiry skips when a live
payment exists, plus the resolver checks the deadline. Without these, a PROCESSING charge could be undone by a timer.

**Why a grace window?** Delayed jobs can fire slightly early (clock skew between Redis and app/DB). Without it a
legitimate expiry would be skipped until the next trigger.

**What if the delayed job is lost (Redis flush)?** Correctness does not depend on it: payment enforces the deadline
and a new offer lazily clears a stale reservation. The job only makes expiry timely.

**Why keyset over OFFSET?** OFFSET is O(n) per deep page and shifts when rows are inserted; keyset is index-seekable and stable.

**Why compute the score on the server?** A client-supplied number can contradict the evidence; one formula keeps
all inspections comparable.

**Why 404 for others' inspections/offers?** 403 confirms existence.

**Bottleneck / scale?** Hot listings serialise on one row lock (fine: sales per listing are rare). Search is
the load: trigram + partial indexes, then a search engine (OpenSearch) fed by outbox events. Read replicas for browse.

**Microservice extraction?** Marketplace depends on payments only via the resolver interface and on notifications via
one call; replace `completeSale` with a `payment.succeeded` event and the resolver with an API call.

**Failure after payment but before SOLD?** Payment is SUCCESS, listing still ACTIVE/reserved; replaying the same
request re-runs the idempotent `completeSale`. A sweeper could repair it without the client.

**Duplicates/retries?** Offers: unique index. Payments: Phase 12 layers. Images: slot retry. Reports: guarded UPDATE.
Jobs: deterministic `jobId` (`expire-offer__<id>`) so re-scheduling cannot double-enqueue.

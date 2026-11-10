import request from "supertest";
import { Worker } from "bullmq";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { env } from "../../src/config/env";
import { closeTestDb } from "./testUtils";
import { ensurePaymentVehicleType, idemKey, registerUser } from "./paymentFixtures";
import { getMarketplaceQueue } from "../../src/queues/marketplaceQueue";
import { startMarketplaceWorker } from "../../src/workers/marketplaceWorker";
import { offersService } from "../../src/modules/marketplace/services/offers.service";
import {
  acceptOffer, ageAcceptedOffer, bearer, createListing, makeOffer, registerBuyer, registerSeller, resetMarketplaceTables,
} from "./marketplaceFixtures";

const app = createApp();
let vt: string;
const TTL = env.OFFER_ACCEPTANCE_TTL_MS;

const offerStatus = async (id: string) => (await pool.query(`SELECT status FROM vehicle_offers WHERE id = $1`, [id])).rows[0].status as string;
const listingStatus = async (id: string) => (await pool.query(`SELECT status FROM vehicle_listings WHERE id = $1`, [id])).rows[0].status as string;

function pay(buyer: { accessToken: string }, offerId: string, token = "tok_mock_success", key = idemKey()) {
  return request(app).post("/api/payments").set(bearer(buyer.accessToken)).set("Idempotency-Key", key)
    .send({ payableType: "MARKETPLACE", payableId: offerId, paymentMethodToken: token });
}

async function setup() {
  const seller = await registerSeller(app);
  const buyer = await registerBuyer(app);
  const listing = await createListing(app, seller, vt, { price: 500000 });
  return { seller, buyer, listing };
}

describe("Marketplace offers, sale and expiry (live DB + Redis + worker)", () => {
  beforeAll(async () => {
    vt = await ensurePaymentVehicleType("MKT_OFFER_SEDAN");
  });
  beforeEach(async () => {
    await resetMarketplaceTables();
    await redis.flushdb();
  });
  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  describe("making offers", () => {
    it("lets a buyer offer between 50% and 100% of the asking price", async () => {
      const { buyer, listing } = await setup();
      const res = await makeOffer(app, buyer, listing.id, 400000);
      expect(res.status).toBe(201);
      expect(res.body.data.offer).toMatchObject({ amount: 400000, askingPrice: 500000, status: "PENDING", listingId: listing.id });
    });

    it("accepts exactly 50% and rejects anything below, above asking, zero or negative", async () => {
      const { buyer, listing } = await setup();
      const b2 = await registerBuyer(app);
      expect((await makeOffer(app, buyer, listing.id, 249999)).status).toBe(400);
      expect((await makeOffer(app, buyer, listing.id, 500001)).status).toBe(400);
      expect((await makeOffer(app, buyer, listing.id, 0)).status).toBe(400);
      expect((await makeOffer(app, buyer, listing.id, -5)).status).toBe(400);
      expect((await makeOffer(app, b2, listing.id, 250000)).status).toBe(201);
    });

    it("forbids non-buyers, anonymous callers and the seller's own offer", async () => {
      const { seller, listing } = await setup();
      expect((await makeOffer(app, seller, listing.id, 400000)).status).toBe(403); // SELLER role only
      expect((await request(app).post(`/api/marketplace/listings/${listing.id}/offers`).send({ amount: 1 })).status).toBe(401);

      const both = await registerUser(app, ["SELLER", "BUYER"]);
      const own = await createListing(app, both, vt);
      expect((await makeOffer(app, both, own.id, 400000)).status).toBe(400);
    });

    it("allows only one PENDING offer per buyer, until it is withdrawn", async () => {
      const { buyer, listing } = await setup();
      const first = await makeOffer(app, buyer, listing.id, 400000);
      expect((await makeOffer(app, buyer, listing.id, 420000)).status).toBe(409);

      await request(app).post(`/api/marketplace/offers/${first.body.data.offer.id}/withdraw`).set(bearer(buyer.accessToken));
      expect((await makeOffer(app, buyer, listing.id, 420000)).status).toBe(201);
    });

    it("404s for a missing or delisted listing and 409s for a sold one", async () => {
      const { seller, buyer, listing } = await setup();
      expect((await makeOffer(app, buyer, "00000000-0000-4000-8000-000000000000", 1)).status).toBe(404);
      await request(app).post(`/api/marketplace/listings/${listing.id}/delist`).set(bearer(seller.accessToken));
      expect((await makeOffer(app, buyer, listing.id, 400000)).status).toBe(404);

      await pool.query(`UPDATE vehicle_listings SET status = 'SOLD' WHERE id = $1`, [listing.id]);
      expect((await makeOffer(app, buyer, listing.id, 400000)).status).toBe(409);
    });

    it("lists offers to the seller (highest first) and to each buyer (their own only)", async () => {
      const { seller, buyer, listing } = await setup();
      const b2 = await registerBuyer(app);
      await makeOffer(app, buyer, listing.id, 300000);
      await makeOffer(app, b2, listing.id, 450000);

      const asSeller = await request(app).get(`/api/marketplace/listings/${listing.id}/offers`).set(bearer(seller.accessToken));
      expect(asSeller.body.data.offers.map((o: { amount: number }) => o.amount)).toEqual([450000, 300000]);

      const mine = await request(app).get("/api/marketplace/offers/mine").set(bearer(buyer.accessToken));
      expect(mine.body.data.offers).toHaveLength(1);
      expect(mine.body.data.offers[0].amount).toBe(300000);

      const other = await registerSeller(app);
      expect((await request(app).get(`/api/marketplace/listings/${listing.id}/offers`).set(bearer(other.accessToken))).status).toBe(404);
      expect((await request(app).get(`/api/marketplace/listings/${listing.id}/offers?status=NOPE`).set(bearer(seller.accessToken))).status).toBe(400);
    });

    it("the database CHECK rejects a non-positive amount even if the app is bypassed", async () => {
      const { buyer, listing } = await setup();
      await expect(pool.query(`INSERT INTO vehicle_offers (listing_id, buyer_id, offer_amount) VALUES ($1, $2, 0)`, [listing.id, buyer.userId])).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("accept / reject / withdraw", () => {
    it("accept reserves the listing, rejects every other pending offer, and schedules the expiry job", async () => {
      const { seller, buyer, listing } = await setup();
      const b2 = await registerBuyer(app);
      const o1 = await makeOffer(app, buyer, listing.id, 450000);
      const o2 = await makeOffer(app, b2, listing.id, 400000);

      const res = await acceptOffer(app, seller, o1.body.data.offer.id);

      expect(res.status).toBe(200);
      expect(res.body.data.offer).toMatchObject({ status: "ACCEPTED" });
      expect(res.body.data.offer.acceptedAt).not.toBeNull();
      expect(await offerStatus(o2.body.data.offer.id)).toBe("REJECTED");

      const detail = await request(app).get(`/api/marketplace/listings/${listing.id}`);
      expect(detail.body.data.listing.isReserved).toBe(true);
      expect(detail.body.data.listing.status).toBe("ACTIVE"); // still ACTIVE: reserved, not sold

      const delayed = await getMarketplaceQueue().getDelayed();
      expect(delayed.map((j) => j.id)).toContain(`expire-offer__${o1.body.data.offer.id}`);
      expect(delayed[0].opts.delay).toBe(TTL);
    });

    it("a second accept is a 409 and a new offer on a reserved listing is a 409", async () => {
      const { seller, buyer, listing } = await setup();
      const b2 = await registerBuyer(app);
      const b3 = await registerBuyer(app);
      const o1 = await makeOffer(app, buyer, listing.id, 450000);
      const o2 = await makeOffer(app, b2, listing.id, 400000);
      await acceptOffer(app, seller, o1.body.data.offer.id);

      expect((await acceptOffer(app, seller, o2.body.data.offer.id)).status).toBe(409); // already rejected
      expect((await makeOffer(app, b3, listing.id, 480000)).status).toBe(409);
      expect((await acceptOffer(app, seller, o1.body.data.offer.id)).status).toBe(409); // already accepted
    });

    it("only the listing's seller can accept or reject (others get 404)", async () => {
      const { buyer, listing } = await setup();
      const other = await registerSeller(app);
      const o = await makeOffer(app, buyer, listing.id, 450000);

      expect((await acceptOffer(app, other, o.body.data.offer.id)).status).toBe(404);
      expect((await request(app).post(`/api/marketplace/offers/${o.body.data.offer.id}/reject`).set(bearer(other.accessToken))).status).toBe(404);
      expect((await acceptOffer(app, buyer, o.body.data.offer.id)).status).toBe(403); // wrong role entirely
    });

    it("reject and withdraw only work on PENDING offers and only for the right party", async () => {
      const { seller, buyer, listing } = await setup();
      const o = (await makeOffer(app, buyer, listing.id, 450000)).body.data.offer.id;
      const stranger = await registerBuyer(app);

      expect((await request(app).post(`/api/marketplace/offers/${o}/withdraw`).set(bearer(stranger.accessToken))).status).toBe(404);
      expect((await request(app).post(`/api/marketplace/offers/${o}/reject`).set(bearer(seller.accessToken))).body.data.offer.status).toBe("REJECTED");
      expect((await request(app).post(`/api/marketplace/offers/${o}/reject`).set(bearer(seller.accessToken))).status).toBe(409);
      expect((await request(app).post(`/api/marketplace/offers/${o}/withdraw`).set(bearer(buyer.accessToken))).status).toBe(409);
    });

    it("a buyer cannot withdraw an ACCEPTED offer (it is a commitment that lapses on its own)", async () => {
      const { seller, buyer, listing } = await setup();
      const o = (await makeOffer(app, buyer, listing.id, 450000)).body.data.offer.id;
      await acceptOffer(app, seller, o);
      expect((await request(app).post(`/api/marketplace/offers/${o}/withdraw`).set(bearer(buyer.accessToken))).status).toBe(409);
    });

    it("price cannot change and the listing cannot be delisted while an offer is accepted", async () => {
      const { seller, buyer, listing } = await setup();
      const o = (await makeOffer(app, buyer, listing.id, 450000)).body.data.offer.id;
      await acceptOffer(app, seller, o);

      expect((await request(app).patch(`/api/marketplace/listings/${listing.id}`).set(bearer(seller.accessToken)).send({ price: 100000 })).status).toBe(409);
      expect((await request(app).patch(`/api/marketplace/listings/${listing.id}`).set(bearer(seller.accessToken)).send({ description: "still editable" })).status).toBe(200);
      expect((await request(app).post(`/api/marketplace/listings/${listing.id}/delist`).set(bearer(seller.accessToken))).status).toBe(409);
    });

    it("the database allows only one ACCEPTED offer per listing and one PENDING per buyer", async () => {
      const { buyer, listing } = await setup();
      const b2 = await registerBuyer(app);
      const ins = (b: string, status: string) =>
        pool.query(`INSERT INTO vehicle_offers (listing_id, buyer_id, offer_amount, status) VALUES ($1, $2, 300000, $3::offer_status)`, [listing.id, b, status]);

      await ins(buyer.userId, "ACCEPTED");
      await expect(ins(b2.userId, "ACCEPTED")).rejects.toMatchObject({ code: "23505" });
      await ins(b2.userId, "PENDING");
      await expect(ins(b2.userId, "PENDING")).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("paying: the sale", () => {
    it("charges the OFFER amount (not the asking price), marks the listing SOLD, and keeps the page public", async () => {
      const { seller, buyer, listing } = await setup();
      const o = (await makeOffer(app, buyer, listing.id, 420000)).body.data.offer.id;
      await acceptOffer(app, seller, o);

      const res = await pay(buyer, o);

      expect(res.status).toBe(201);
      expect(res.body.data.payment).toMatchObject({ status: "SUCCESS", amount: 420000, payableType: "MARKETPLACE" });
      expect(await listingStatus(listing.id)).toBe("SOLD");
      expect((await request(app).get(`/api/marketplace/listings/${listing.id}`)).status).toBe(200);
      expect((await request(app).get("/api/marketplace/listings")).body.data.listings).toHaveLength(0); // no longer searchable
    });

    it("cannot be paid before it is accepted, by a stranger, or twice", async () => {
      const { seller, buyer, listing } = await setup();
      const o = (await makeOffer(app, buyer, listing.id, 420000)).body.data.offer.id;
      const stranger = await registerBuyer(app);

      expect((await pay(buyer, o)).status).toBe(400); // PENDING
      await acceptOffer(app, seller, o);
      expect((await pay(stranger, o)).status).toBe(404);
      expect((await pay(buyer, o)).status).toBe(201);
      expect((await pay(buyer, o)).status).toBe(409);
    });

    it("a declined card leaves the offer ACCEPTED and the listing reserved; a retry completes the sale", async () => {
      const { seller, buyer, listing } = await setup();
      const o = (await makeOffer(app, buyer, listing.id, 420000)).body.data.offer.id;
      await acceptOffer(app, seller, o);

      expect((await pay(buyer, o, "tok_mock_decline")).status).toBe(402);
      expect(await offerStatus(o)).toBe("ACCEPTED");
      expect(await listingStatus(listing.id)).toBe("ACTIVE");
      expect((await pay(buyer, o, "tok_mock_success")).status).toBe(201);
      expect(await listingStatus(listing.id)).toBe("SOLD");
    });

    it("a sold listing cannot be edited, relisted, delisted or offered on", async () => {
      const { seller, buyer, listing } = await setup();
      const o = (await makeOffer(app, buyer, listing.id, 420000)).body.data.offer.id;
      await acceptOffer(app, seller, o);
      await pay(buyer, o);

      const b2 = await registerBuyer(app);
      expect((await request(app).patch(`/api/marketplace/listings/${listing.id}`).set(bearer(seller.accessToken)).send({ price: 1 })).status).toBe(409);
      expect((await request(app).post(`/api/marketplace/listings/${listing.id}/relist`).set(bearer(seller.accessToken))).status).toBe(409);
      expect((await request(app).post(`/api/marketplace/listings/${listing.id}/delist`).set(bearer(seller.accessToken))).status).toBe(409);
      expect((await makeOffer(app, b2, listing.id, 400000)).status).toBe(409);
    });

    it("a replayed payment does not sell twice", async () => {
      const { seller, buyer, listing } = await setup();
      const o = (await makeOffer(app, buyer, listing.id, 420000)).body.data.offer.id;
      await acceptOffer(app, seller, o);
      const key = idemKey();
      await pay(buyer, o, "tok_mock_success", key);
      const again = await pay(buyer, o, "tok_mock_success", key);
      expect(again.status).toBe(201);
      expect((await pool.query(`SELECT count(*)::int AS n FROM payments WHERE payable_id = $1`, [o])).rows[0].n).toBe(1);
    });
  });

  describe("expiry of an unpaid accepted offer", () => {
    it("expires an overdue offer, reopens the listing, and lets another buyer offer", async () => {
      const { seller, buyer, listing } = await setup();
      const b2 = await registerBuyer(app);
      const o = (await makeOffer(app, buyer, listing.id, 450000)).body.data.offer.id;
      await acceptOffer(app, seller, o);
      await ageAcceptedOffer(o, TTL + 1000);

      await offersService.expireIfDue(o);

      expect(await offerStatus(o)).toBe("EXPIRED");
      expect((await request(app).get(`/api/marketplace/listings/${listing.id}`)).body.data.listing.isReserved).toBe(false);
      expect((await makeOffer(app, b2, listing.id, 430000)).status).toBe(201);
    });

    it("does nothing when the offer is not yet due, and is idempotent when run twice", async () => {
      const { seller, buyer, listing } = await setup();
      const o = (await makeOffer(app, buyer, listing.id, 450000)).body.data.offer.id;
      await acceptOffer(app, seller, o);

      await offersService.expireIfDue(o); // just accepted: not due
      expect(await offerStatus(o)).toBe("ACCEPTED");

      await ageAcceptedOffer(o, TTL + 1000);
      await offersService.expireIfDue(o);
      await offersService.expireIfDue(o);
      expect(await offerStatus(o)).toBe("EXPIRED");
    });

    it("the delayed job fires through a real worker", async () => {
      const { seller, buyer, listing } = await setup();
      const o = (await makeOffer(app, buyer, listing.id, 450000)).body.data.offer.id;
      await acceptOffer(app, seller, o);
      await ageAcceptedOffer(o, TTL + 1000);

      const worker: Worker = startMarketplaceWorker(2);
      try {
        await worker.waitUntilReady();
        await getMarketplaceQueue().add("expire-offer", { offerId: o }); // as if the delay had elapsed
        const deadline = Date.now() + 8000;
        while ((await offerStatus(o)) !== "EXPIRED" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        expect(await offerStatus(o)).toBe("EXPIRED");
      } finally {
        await worker.close();
      }
    });

    it("a job that fires early (inside the grace window) still expires; one that fires far too early does not", async () => {
      const { seller, buyer, listing } = await setup();
      const o = (await makeOffer(app, buyer, listing.id, 450000)).body.data.offer.id;
      await acceptOffer(app, seller, o);

      await ageAcceptedOffer(o, TTL - 60_000); // a minute early: well outside the 5s grace
      await offersService.expireIfDue(o);
      expect(await offerStatus(o)).toBe("ACCEPTED");

      await ageAcceptedOffer(o, TTL - 2_000); // 2s early: inside the grace window
      await offersService.expireIfDue(o);
      expect(await offerStatus(o)).toBe("EXPIRED");
    });

    it("payment is refused for an overdue offer even if the expiry job never ran, and expires it inline", async () => {
      const { seller, buyer, listing } = await setup();
      const o = (await makeOffer(app, buyer, listing.id, 450000)).body.data.offer.id;
      await acceptOffer(app, seller, o);
      await ageAcceptedOffer(o, TTL + 60_000);

      const res = await pay(buyer, o);

      expect(res.status).toBe(409);
      expect(await offerStatus(o)).toBe("EXPIRED");
      expect(await listingStatus(listing.id)).toBe("ACTIVE");
      expect((await pool.query(`SELECT count(*)::int AS n FROM payments WHERE payable_id = $1`, [o])).rows[0].n).toBe(0);
    });

    it("the timer never expires an offer while a payment for it is in flight (PROCESSING)", async () => {
      const { seller, buyer, listing } = await setup();
      const o = (await makeOffer(app, buyer, listing.id, 450000)).body.data.offer.id;
      await acceptOffer(app, seller, o);
      expect((await pay(buyer, o, "tok_mock_error")).status).toBe(502); // provider error leaves the payment PROCESSING
      await ageAcceptedOffer(o, TTL - 1_000);

      await offersService.expireIfDue(o);
      expect(await offerStatus(o)).toBe("ACCEPTED");
    });

    it("a new offer lazily clears a stale reservation without waiting for the job", async () => {
      const { seller, buyer, listing } = await setup();
      const b2 = await registerBuyer(app);
      const o = (await makeOffer(app, buyer, listing.id, 450000)).body.data.offer.id;
      await acceptOffer(app, seller, o);
      await ageAcceptedOffer(o, TTL + 1000);

      expect((await makeOffer(app, b2, listing.id, 430000)).status).toBe(201);
      expect(await offerStatus(o)).toBe("EXPIRED");
    });
  });
});

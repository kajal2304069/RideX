import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { env } from "../../src/config/env";
import { closeTestDb } from "./testUtils";
import { ensurePaymentVehicleType, idemKey } from "./paymentFixtures";
import { offersService } from "../../src/modules/marketplace/services/offers.service";
import {
  acceptOffer, ageAcceptedOffer, bearer, createListing, futureDate, goodReport, makeOffer,
  registerBuyer, registerMechanic, registerSeller, resetMarketplaceTables,
} from "./marketplaceFixtures";

const app = createApp();
let vt: string;
const TTL = env.OFFER_ACCEPTANCE_TTL_MS;
const count = (rs: { status: number }[], s: number) => rs.filter((r) => r.status === s).length;

const pay = (buyer: { accessToken: string }, offerId: string, key = idemKey()) =>
  request(app).post("/api/payments").set(bearer(buyer.accessToken)).set("Idempotency-Key", key)
    .send({ payableType: "MARKETPLACE", payableId: offerId, paymentMethodToken: "tok_mock_success" });

describe("Marketplace concurrency (live DB + Redis)", () => {
  beforeAll(async () => { vt = await ensurePaymentVehicleType("MKT_CONC_SEDAN"); });
  beforeEach(async () => { await resetMarketplaceTables(); await redis.flushdb(); });
  afterAll(async () => { await closeTestDb(); redis.disconnect(); });

  it("N pending offers accepted at once: exactly one 200, the rest 409, one ACCEPTED row, the others REJECTED", async () => {
    const seller = await registerSeller(app);
    const listing = await createListing(app, seller, vt);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const b = await registerBuyer(app);
      ids.push((await makeOffer(app, b, listing.id, 300000 + i * 10000)).body.data.offer.id);
    }
    const rs = await Promise.all(ids.map((id) => acceptOffer(app, seller, id)));
    expect(count(rs, 200)).toBe(1);
    expect(count(rs, 409)).toBe(5);
    const { rows } = await pool.query(`SELECT status, count(*)::int n FROM vehicle_offers WHERE listing_id=$1 GROUP BY status`, [listing.id]);
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    expect(by).toEqual({ ACCEPTED: 1, REJECTED: 5 });
  });

  it("the same offer accepted twice at once is one 200 and one 409", async () => {
    const seller = await registerSeller(app);
    const buyer = await registerBuyer(app);
    const listing = await createListing(app, seller, vt);
    const o = (await makeOffer(app, buyer, listing.id, 400000)).body.data.offer.id;
    const rs = await Promise.all([acceptOffer(app, seller, o), acceptOffer(app, seller, o)]);
    expect([count(rs, 200), count(rs, 409)]).toEqual([1, 1]);
  });

  it("accept vs delist race never leaves a delisted listing with an accepted offer", async () => {
    for (let round = 0; round < 5; round++) {
      const seller = await registerSeller(app);
      const buyer = await registerBuyer(app);
      const listing = await createListing(app, seller, vt);
      const o = (await makeOffer(app, buyer, listing.id, 400000)).body.data.offer.id;
      const [a, d] = await Promise.all([
        acceptOffer(app, seller, o),
        request(app).post(`/api/marketplace/listings/${listing.id}/delist`).set(bearer(seller.accessToken)),
      ]);
      const l = (await pool.query(`SELECT status FROM vehicle_listings WHERE id=$1`, [listing.id])).rows[0].status;
      const off = (await pool.query(`SELECT status FROM vehicle_offers WHERE id=$1`, [o])).rows[0].status;
      // Exactly one of the two wins, and the final state is consistent with the winner.
      expect([a.status, d.status].filter((s) => s === 200)).toHaveLength(1);
      if (a.status === 200) { expect(l).toBe("ACTIVE"); expect(off).toBe("ACCEPTED"); expect(d.status).toBe(409); }
      else { expect(l).toBe("DELISTED"); expect(off).not.toBe("ACCEPTED"); expect(a.status).toBeGreaterThanOrEqual(400); }
    }
  });

  it("N identical offers from one buyer produce exactly one 201", async () => {
    const seller = await registerSeller(app);
    const buyer = await registerBuyer(app);
    const listing = await createListing(app, seller, vt);
    const rs = await Promise.all(Array.from({ length: 8 }, () => makeOffer(app, buyer, listing.id, 400000)));
    expect(count(rs, 201)).toBe(1);
    expect(count(rs, 409)).toBe(7);
    expect((await pool.query(`SELECT count(*)::int n FROM vehicle_offers WHERE listing_id=$1`, [listing.id])).rows[0].n).toBe(1);
  });

  it("10 simultaneous payments with different keys: one payment, one sale", async () => {
    const seller = await registerSeller(app);
    const buyer = await registerBuyer(app);
    const listing = await createListing(app, seller, vt);
    const o = (await makeOffer(app, buyer, listing.id, 400000)).body.data.offer.id;
    await acceptOffer(app, seller, o);
    const rs = await Promise.all(Array.from({ length: 10 }, () => pay(buyer, o)));
    expect(count(rs, 201)).toBe(1);
    expect(count(rs, 409)).toBe(9);
    expect((await pool.query(`SELECT count(*)::int n FROM payments WHERE payable_id=$1 AND status='SUCCESS'`, [o])).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT status FROM vehicle_listings WHERE id=$1`, [listing.id])).rows[0].status).toBe("SOLD");
  });

  it("payment vs expiry race inside the grace window never yields SUCCESS + EXPIRED or SOLD + EXPIRED", async () => {
    for (let round = 0; round < 6; round++) {
      const seller = await registerSeller(app);
      const buyer = await registerBuyer(app);
      const listing = await createListing(app, seller, vt);
      const o = (await makeOffer(app, buyer, listing.id, 400000)).body.data.offer.id;
      await acceptOffer(app, seller, o);
      await ageAcceptedOffer(o, TTL - 2_000); // inside the 5s grace: the timer WOULD expire it if it won the lock

      await Promise.all([pay(buyer, o), offersService.expireIfDue(o)]);

      const off = (await pool.query(`SELECT status FROM vehicle_offers WHERE id=$1`, [o])).rows[0].status as string;
      const l = (await pool.query(`SELECT status FROM vehicle_listings WHERE id=$1`, [listing.id])).rows[0].status as string;
      const paid = (await pool.query(`SELECT count(*)::int n FROM payments WHERE payable_id=$1 AND status='SUCCESS'`, [o])).rows[0].n as number;
      if (paid === 1) { expect(off).toBe("ACCEPTED"); expect(l).toBe("SOLD"); }
      else { expect(off).toBe("EXPIRED"); expect(l).toBe("ACTIVE"); }
    }
  });

  it("two mechanics submitting a report at once: one 200, one 409", async () => {
    const seller = await registerSeller(app);
    const buyer = await registerBuyer(app);
    const listing = await createListing(app, seller, vt);
    const insp = (await request(app).post(`/api/marketplace/listings/${listing.id}/inspections`).set(bearer(buyer.accessToken)).send({ scheduledAt: futureDate(48) })).body.data.inspection;
    await pool.query(`UPDATE vehicle_inspections SET scheduled_at = now() - interval '1 hour' WHERE id=$1`, [insp.id]);
    const mechs = await Promise.all([registerMechanic(app), registerMechanic(app), registerMechanic(app)]);
    const rs = await Promise.all(mechs.map((m) => request(app).post(`/api/marketplace/inspections/${insp.id}/report`).set(bearer(m.accessToken)).send(goodReport)));
    expect(count(rs, 200)).toBe(1);
    expect(count(rs, 409)).toBe(2);
    const row = (await pool.query(`SELECT inspector_id, status FROM vehicle_inspections WHERE id=$1`, [insp.id])).rows[0];
    const winner = mechs[rs.findIndex((r) => r.status === 200)];
    expect(row).toEqual({ inspector_id: winner.userId, status: "COMPLETED" });
  });

  it("10 concurrent image adds fill positions 0..9 uniquely; 12 adds yield exactly 10 successes", async () => {
    const seller = await registerSeller(app);
    const listing = await createListing(app, seller, vt);
    const add = (i: number) => request(app).post(`/api/marketplace/listings/${listing.id}/images`).set(bearer(seller.accessToken)).send({ url: `https://img.example.com/${i}.jpg` });
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => add(i)));
    expect(count(rs, 201)).toBe(10);
    expect(count(rs, 409)).toBe(2);
    const pos = (await pool.query(`SELECT position FROM vehicle_images WHERE listing_id=$1 ORDER BY position`, [listing.id])).rows.map((r) => r.position);
    expect(pos).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

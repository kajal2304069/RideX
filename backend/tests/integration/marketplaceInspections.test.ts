import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";
import { ensurePaymentVehicleType, makeAdmin, registerUser } from "./paymentFixtures";
import {
  bearer, createListing, futureDate, goodReport, registerBuyer, registerMechanic, registerSeller, resetMarketplaceTables,
} from "./marketplaceFixtures";

const app = createApp();
let vt: string;

const schedule = (buyer: { accessToken: string }, listingId: string, scheduledAt: unknown = futureDate(48)) =>
  request(app).post(`/api/marketplace/listings/${listingId}/inspections`).set(bearer(buyer.accessToken)).send({ scheduledAt });
const report = (mech: { accessToken: string }, id: string, body: unknown = goodReport) =>
  request(app).post(`/api/marketplace/inspections/${id}/report`).set(bearer(mech.accessToken)).send(body as object);
const backdate = (id: string, hours: number) =>
  pool.query(`UPDATE vehicle_inspections SET scheduled_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [id, String(hours)]);

async function setup() {
  const seller = await registerSeller(app);
  const buyer = await registerBuyer(app);
  const mech = await registerMechanic(app);
  const listing = await createListing(app, seller, vt);
  const insp = (await schedule(buyer, listing.id)).body.data.inspection;
  return { seller, buyer, mech, listing, insp };
}

describe("Marketplace inspections (live DB)", () => {
  beforeAll(async () => { vt = await ensurePaymentVehicleType("MKT_INSP_SEDAN"); });
  beforeEach(async () => { await resetMarketplaceTables(); await redis.flushdb(); });
  afterAll(async () => { await closeTestDb(); redis.disconnect(); });

  describe("scheduling", () => {
    it("schedules a future inspection", async () => {
      const { insp, listing, buyer } = await setup();
      expect(insp).toMatchObject({ status: "SCHEDULED", listingId: listing.id, buyerId: buyer.userId, inspectorId: null, report: null });
    });

    it("rejects past, too-far, malformed and extra fields; blocks non-buyers and anonymous", async () => {
      const seller = await registerSeller(app);
      const buyer = await registerBuyer(app);
      const l = await createListing(app, seller, vt);
      expect((await schedule(buyer, l.id, futureDate(-1))).status).toBe(400);
      expect((await schedule(buyer, l.id, futureDate(61 * 24))).status).toBe(400);
      expect((await schedule(buyer, l.id, "not-a-date")).status).toBe(400);
      expect((await request(app).post(`/api/marketplace/listings/${l.id}/inspections`).set(bearer(buyer.accessToken)).send({ scheduledAt: futureDate(), inspectorId: "x" })).status).toBe(400);
      expect((await schedule(seller, l.id)).status).toBe(403);
      expect((await request(app).post(`/api/marketplace/listings/${l.id}/inspections`).send({ scheduledAt: futureDate() })).status).toBe(401);
    });

    it("404s for missing/delisted listings, 409s for sold, 400s for your own", async () => {
      const seller = await registerSeller(app);
      const buyer = await registerBuyer(app);
      const l = await createListing(app, seller, vt);
      expect((await schedule(buyer, "00000000-0000-4000-8000-000000000000")).status).toBe(404);

      const both = await registerUser(app, ["SELLER", "BUYER"]);
      const own = await createListing(app, both, vt);
      expect((await schedule(both, own.id)).status).toBe(400);

      await pool.query(`UPDATE vehicle_listings SET status='SOLD' WHERE id=$1`, [l.id]);
      expect((await schedule(buyer, l.id)).status).toBe(409);
      await pool.query(`UPDATE vehicle_listings SET status='DELISTED' WHERE id=$1`, [l.id]);
      expect((await schedule(buyer, l.id)).status).toBe(404);
    });

    it("one SCHEDULED inspection per buyer per listing until cancelled", async () => {
      const { buyer, listing, insp } = await setup();
      expect((await schedule(buyer, listing.id)).status).toBe(409);
      expect((await request(app).post(`/api/marketplace/inspections/${insp.id}/cancel`).set(bearer(buyer.accessToken))).body.data.inspection.status).toBe("CANCELLED");
      expect((await schedule(buyer, listing.id)).status).toBe(201);
      const other = await registerBuyer(app);
      expect((await schedule(other, listing.id)).status).toBe(201);
    });
  });

  describe("reports", () => {
    it("blocks a report before the slot (minus 1h tolerance) and allows it afterwards", async () => {
      const { mech, insp } = await setup();
      expect((await report(mech, insp.id)).status).toBe(400);
      await backdate(insp.id, -0.5); // 30 min from now: inside the 1h tolerance
      expect((await report(mech, insp.id)).status).toBe(200);
    });

    it("derives overallScore and flags on the server", async () => {
      const { mech, insp } = await setup();
      await backdate(insp.id, 1);
      const res = await report(mech, insp.id, {
        ...goodReport, engine: { score: 2 }, accidentHistory: { hadAccident: true, details: "rear" }, documents: { verified: false },
      });
      expect(res.status).toBe(200);
      const r = res.body.data.inspection.report;
      expect(r.overallScore).toBe(6.7); // (2+7+9+6+8+8)/6 = 6.67
      expect(r.flags.sort()).toEqual(["ACCIDENT_HISTORY", "DOCUMENTS_NOT_VERIFIED", "ENGINE_POOR"]);
      expect(res.body.data.inspection).toMatchObject({ status: "COMPLETED", inspectorId: mech.userId });
    });

    it("rejects client-supplied overallScore/flags and malformed scores", async () => {
      const { mech, insp } = await setup();
      await backdate(insp.id, 1);
      expect((await report(mech, insp.id, { ...goodReport, overallScore: 10 })).status).toBe(400);
      expect((await report(mech, insp.id, { ...goodReport, flags: [] })).status).toBe(400);
      expect((await report(mech, insp.id, { ...goodReport, engine: { score: 11 } })).status).toBe(400);
      expect((await report(mech, insp.id, { ...goodReport, engine: { score: 0 } })).status).toBe(400);
      expect((await report(mech, insp.id, { ...goodReport, engine: { score: 5.5 } })).status).toBe(400);
      const { brakes: _b, ...missing } = goodReport;
      expect((await report(mech, insp.id, missing)).status).toBe(400);
    });

    it("needs the MECHANIC role; buyer or seller who are also mechanics get 403", async () => {
      const seller = await registerUser(app, ["SELLER", "MECHANIC"]);
      const buyer = await registerUser(app, ["BUYER", "MECHANIC"]);
      const l = await createListing(app, seller, vt);
      const i = (await schedule(buyer, l.id)).body.data.inspection;
      await backdate(i.id, 1);
      const plainBuyer = await registerBuyer(app);
      expect((await report(plainBuyer, i.id)).status).toBe(403);
      expect((await report(buyer, i.id)).status).toBe(403);
      expect((await report(seller, i.id)).status).toBe(403);
    });

    it("a second report or a report on a cancelled inspection is a 409", async () => {
      const { buyer, mech, insp, listing } = await setup();
      await backdate(insp.id, 1);
      expect((await report(mech, insp.id)).status).toBe(200);
      const m2 = await registerMechanic(app);
      expect((await report(m2, insp.id)).status).toBe(409);
      expect((await request(app).post(`/api/marketplace/inspections/${insp.id}/cancel`).set(bearer(buyer.accessToken))).status).toBe(409);

      const other = await registerBuyer(app);
      const i2 = (await schedule(other, listing.id)).body.data.inspection;
      await request(app).post(`/api/marketplace/inspections/${i2.id}/cancel`).set(bearer(other.accessToken));
      await backdate(i2.id, 1);
      expect((await report(mech, i2.id)).status).toBe(409);
    });

    it("404s for an unknown inspection id", async () => {
      const mech = await registerMechanic(app);
      expect((await report(mech, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    });
  });

  describe("visibility", () => {
    it("buyer, seller, inspector and admin can read; everyone else gets 404", async () => {
      const { seller, buyer, mech, insp } = await setup();
      const admin = await makeAdmin(app);
      const stranger = await registerBuyer(app);
      const otherMech = await registerMechanic(app);
      await backdate(insp.id, 1);
      await report(mech, insp.id);

      const get = (u: { accessToken: string }) => request(app).get(`/api/marketplace/inspections/${insp.id}`).set(bearer(u.accessToken));
      for (const u of [buyer, seller, mech, admin]) expect((await get(u)).status).toBe(200);
      expect((await get(stranger)).status).toBe(404);
      expect((await get(otherMech)).status).toBe(404);
      expect((await request(app).get(`/api/marketplace/inspections/${insp.id}`)).status).toBe(401);
    });

    it("buyers list their own, mechanics see open ones, sellers see their listing's inspections", async () => {
      const { seller, buyer, mech, insp, listing } = await setup();
      const stranger = await registerBuyer(app);
      const otherSeller = await registerSeller(app);

      expect((await request(app).get("/api/marketplace/inspections/mine").set(bearer(buyer.accessToken))).body.data.inspections).toHaveLength(1);
      expect((await request(app).get("/api/marketplace/inspections/mine").set(bearer(stranger.accessToken))).body.data.inspections).toHaveLength(0);
      expect((await request(app).get("/api/marketplace/inspections/open").set(bearer(mech.accessToken))).body.data.inspections.map((i: { id: string }) => i.id)).toContain(insp.id);
      expect((await request(app).get("/api/marketplace/inspections/open").set(bearer(buyer.accessToken))).status).toBe(403);
      expect((await request(app).get(`/api/marketplace/listings/${listing.id}/inspections`).set(bearer(seller.accessToken))).body.data.inspections).toHaveLength(1);
      expect((await request(app).get(`/api/marketplace/listings/${listing.id}/inspections`).set(bearer(otherSeller.accessToken))).status).toBe(404);

      await backdate(insp.id, 1);
      await report(mech, insp.id);
      expect((await request(app).get("/api/marketplace/inspections/open").set(bearer(mech.accessToken))).body.data.inspections).toHaveLength(0);
    });

    it("only the buyer can cancel (others 404)", async () => {
      const { seller, insp } = await setup();
      const stranger = await registerBuyer(app);
      expect((await request(app).post(`/api/marketplace/inspections/${insp.id}/cancel`).set(bearer(stranger.accessToken))).status).toBe(404);
      expect((await request(app).post(`/api/marketplace/inspections/${insp.id}/cancel`).set(bearer(seller.accessToken))).status).toBe(403);
    });
  });
});

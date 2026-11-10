import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";
import { createCompletedRide, ensurePaymentVehicleType, makeAdmin, readyDriver, registerUser } from "./paymentFixtures";
import { bearer } from "./garageFixtures";

const app = createApp();
let vt: string;
let admin: { userId: string; accessToken: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Phase 19: endpoints the web app depends on (live DB + Redis)", () => {
  beforeAll(async () => { vt = await ensurePaymentVehicleType("P19_TEST"); });
  beforeEach(async () => { await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`); await redis.flushdb(); admin = await makeAdmin(app); });
  afterAll(async () => { await sleep(300); await closeTestDb(); redis.disconnect(); });

  describe("GET /vehicles/types", () => {
    it("is public and lists active types with their rates", async () => {
      const res = await request(app).get("/api/vehicles/types");
      expect(res.status).toBe(200);
      const t = res.body.data.vehicleTypes.find((x: { code: string }) => x.code === "P19_TEST");
      expect(t).toMatchObject({ id: vt, baseFare: expect.any(Number), perKmRate: expect.any(Number), perMinRate: expect.any(Number) });
      expect(Object.keys(t).sort()).toEqual(["baseFare", "category", "code", "id", "name", "perKmRate", "perMinRate"]);
    });
    it("is not shadowed by the /:vehicleId route", async () => {
      const res = await request(app).get("/api/vehicles/types");
      expect(res.body.error).toBeUndefined();
    });
  });

  describe("GET /vehicles/drivers/lookup", () => {
    const lookup = (t: string, email: string) => request(app).get("/api/vehicles/drivers/lookup").query({ email }).set(bearer(t));
    async function freeDriver(verified: boolean) {
      const d = await registerUser(app, ["DRIVER"]);
      await request(app).post("/api/drivers/onboard").set(bearer(d.accessToken)).send({ licenseNumber: `DL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, licenseExpiry: "2030-06-30" });
      if (verified) await request(app).patch(`/api/drivers/${d.userId}/verification`).set(bearer(admin.accessToken)).send({ status: "VERIFIED" });
      return d;
    }
    it("finds a verified, unassigned driver by exact email", async () => {
      const owner = await registerUser(app, ["VEHICLE_OWNER"]);
      const d = await freeDriver(true);
      const res = await lookup(owner.accessToken, d.email);
      expect(res.status).toBe(200);
      expect(res.body.data.driver).toMatchObject({ id: d.userId, fullName: expect.any(String) });
    });
    it("matches the exact email only, never a prefix", async () => {
      const owner = await registerUser(app, ["VEHICLE_OWNER"]);
      const d = await freeDriver(true);
      expect((await lookup(owner.accessToken, d.email.slice(0, 8))).body.data.driver).toBeNull();
    });
    it("does not return an unverified driver", async () => {
      const owner = await registerUser(app, ["VEHICLE_OWNER"]);
      const d = await freeDriver(false);
      expect((await lookup(owner.accessToken, d.email)).body.data.driver).toBeNull();
    });
    it("does not return a driver who already has a vehicle", async () => {
      const owner = await registerUser(app, ["VEHICLE_OWNER"]);
      const busy = await readyDriver(app, vt, admin.accessToken);
      expect((await lookup(owner.accessToken, busy.email)).body.data.driver).toBeNull();
    });
    it("does not return users who are not drivers", async () => {
      const owner = await registerUser(app, ["VEHICLE_OWNER"]);
      const rider = await registerUser(app, ["RIDER"]);
      expect((await lookup(owner.accessToken, rider.email)).body.data.driver).toBeNull();
    });
    it("is owner-only", async () => {
      const rider = await registerUser(app, ["RIDER"]);
      expect((await lookup(rider.accessToken, "x@y.zz")).status).toBe(403);
    });
  });

  describe("ride fare on ride payloads", () => {
    it("is null before completion and filled after", async () => {
      const { rideId, rider } = await createCompletedRide(app, vt, admin);
      const done = await request(app).get(`/api/rides/${rideId}`).set(bearer(rider.accessToken));
      expect(done.body.data.ride.fare).toMatchObject({ totalFare: expect.any(Number), currency: "INR" });
      expect(done.body.data.ride.fare.totalFare).toBeGreaterThan(0);
    });
    it("is null for a ride that has not been completed", async () => {
      const rider = await registerUser(app, ["RIDER"]);
      const r = await request(app).post("/api/rides/request").set(bearer(rider.accessToken)).send({
        pickup: { lat: 12.9716, lng: 77.5946, address: "A" }, dropoff: { lat: 12.935, lng: 77.6245, address: "B" }, vehicleTypeId: vt, idempotencyKey: `k-${Date.now()}-aaaaaa`,
      });
      const res = await request(app).get(`/api/rides/${r.body.data.ride.id}`).set(bearer(rider.accessToken));
      expect(res.body.data.ride.fare).toBeNull();
    });
  });

  describe("who is on the ride (driver card / rider card)", () => {
    async function liveRide() {
      const driver = await readyDriver(app, vt, admin.accessToken);
      const rider = await registerUser(app, ["RIDER"]);
      const r = await request(app).post("/api/rides/request").set(bearer(rider.accessToken)).send({
        pickup: { lat: 12.9716, lng: 77.5946, address: "A" }, dropoff: { lat: 12.935, lng: 77.6245, address: "B" }, vehicleTypeId: vt, idempotencyKey: `k-${Date.now()}-cardcc`,
      });
      const rideId = r.body.data.ride.id as string;
      await request(app).post(`/api/rides/${rideId}/accept`).set(bearer(driver.accessToken));
      return { rideId, rider, driver };
    }
    it("the rider sees the driver's name, rating, car and plate, and the phone while the ride is live", async () => {
      const { rideId, rider, driver } = await liveRide();
      await pool.query(`UPDATE users SET phone = '+919800000001' WHERE id = $1`, [driver.userId]);
      const res = await request(app).get(`/api/rides/${rideId}`).set(bearer(rider.accessToken));
      expect(res.body.data.ride.driver).toMatchObject({ id: driver.userId, fullName: expect.any(String), phone: "+919800000001", ratingAvg: expect.any(Number) });
      expect(res.body.data.ride.driver.vehicle).toMatchObject({ registrationNumber: expect.any(String), brand: expect.any(String) });
      expect(res.body.data.ride.rider).toBeNull();
      const cur = await request(app).get("/api/rides/current").set(bearer(rider.accessToken));
      expect(cur.body.data.ride.driver.fullName).toBe(res.body.data.ride.driver.fullName);
    });
    it("the driver sees the customer's name and phone, and no driver card", async () => {
      const { rideId, rider, driver } = await liveRide();
      await pool.query(`UPDATE users SET phone = '+919800000002' WHERE id = $1`, [rider.userId]);
      const res = await request(app).get(`/api/rides/${rideId}`).set(bearer(driver.accessToken));
      expect(res.body.data.ride.rider).toMatchObject({ id: rider.userId, phone: "+919800000002" });
      expect(res.body.data.ride.driver).toBeNull();
    });
    it("the phone number disappears once the trip is over", async () => {
      const { rideId, rider, driver } = await createCompletedRide(app, vt, admin);
      await pool.query(`UPDATE users SET phone = '+919800000003' WHERE id = $1`, [driver.userId]);
      const res = await request(app).get(`/api/rides/${rideId}`).set(bearer(rider.accessToken));
      expect(res.body.data.ride.driver.fullName).toBeTruthy();
      expect(res.body.data.ride.driver.phone).toBeNull();
    });
    it("a stranger cannot read the ride or the people on it", async () => {
      const { rideId } = await liveRide();
      const stranger = await registerUser(app, ["RIDER"]);
      expect((await request(app).get(`/api/rides/${rideId}`).set(bearer(stranger.accessToken))).status).toBe(404);
    });
    it("a ride with no driver yet has no driver card", async () => {
      const rider = await registerUser(app, ["RIDER"]);
      const r = await request(app).post("/api/rides/request").set(bearer(rider.accessToken)).send({
        pickup: { lat: 12.9716, lng: 77.5946, address: "A" }, dropoff: { lat: 12.935, lng: 77.6245, address: "B" }, vehicleTypeId: vt, idempotencyKey: `k-${Date.now()}-nodrv`,
      });
      const res = await request(app).get(`/api/rides/${r.body.data.ride.id}`).set(bearer(rider.accessToken));
      expect(res.body.data.ride.driver).toBeNull();
    });
  });

  describe("ride rating", () => {
    it("lets the rider rate once and updates the driver's average", async () => {
      const { rideId, rider, driver } = await createCompletedRide(app, vt, admin);
      const first = await request(app).post(`/api/rides/${rideId}/rate`).set(bearer(rider.accessToken)).send({ rating: 4, comment: "Smooth" });
      expect(first.status).toBe(201);
      const avg = Number((await pool.query(`SELECT rating_avg FROM drivers WHERE user_id = $1`, [driver.userId])).rows[0].rating_avg);
      expect(avg).toBeCloseTo(4, 1);
      const again = await request(app).post(`/api/rides/${rideId}/rate`).set(bearer(rider.accessToken)).send({ rating: 1 });
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(Number((await pool.query(`SELECT rating_avg FROM drivers WHERE user_id = $1`, [driver.userId])).rows[0].rating_avg)).toBeCloseTo(4, 1);
      const mine = await request(app).get(`/api/rides/${rideId}/rating`).set(bearer(rider.accessToken));
      expect(mine.status).toBe(200);
    });
    it("rejects out-of-range ratings", async () => {
      const { rideId, rider } = await createCompletedRide(app, vt, admin);
      for (const rating of [0, 6, 2.5]) {
        const res = await request(app).post(`/api/rides/${rideId}/rate`).set(bearer(rider.accessToken)).send({ rating });
        expect(res.status).toBe(400);
      }
    });
    it("hides the ride from someone who was not on it", async () => {
      const { rideId } = await createCompletedRide(app, vt, admin);
      const stranger = await registerUser(app, ["RIDER"]);
      const res = await request(app).post(`/api/rides/${rideId}/rate`).set(bearer(stranger.accessToken)).send({ rating: 5 });
      expect(res.status).toBe(404);
    });
    it("cannot rate a ride that is not completed", async () => {
      const rider = await registerUser(app, ["RIDER"]);
      const r = await request(app).post("/api/rides/request").set(bearer(rider.accessToken)).send({
        pickup: { lat: 12.9716, lng: 77.5946, address: "A" }, dropoff: { lat: 12.935, lng: 77.6245, address: "B" }, vehicleTypeId: vt, idempotencyKey: `k-${Date.now()}-bbbbbb`,
      });
      const res = await request(app).post(`/api/rides/${r.body.data.ride.id}/rate`).set(bearer(rider.accessToken)).send({ rating: 5 });
      expect(res.status).toBe(409);
    });
    it("concurrent double-submit stores exactly one rating", async () => {
      const { rideId, rider } = await createCompletedRide(app, vt, admin);
      const rs = await Promise.all([1, 2, 3, 4].map(() => request(app).post(`/api/rides/${rideId}/rate`).set(bearer(rider.accessToken)).send({ rating: 5 })));
      expect(rs.filter((r) => r.status === 201).length).toBe(1);
      expect(Number((await pool.query(`SELECT count(*) FROM ratings WHERE ride_id = $1`, [rideId])).rows[0].count)).toBe(1);
    });
  });
});

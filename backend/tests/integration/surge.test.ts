import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { env } from "../../src/config/env";
import { closeTestDb } from "./testUtils";
import { ensurePaymentVehicleType, idemKey, makeAdmin, readyDriver, registerUser, resetPaymentTables } from "./paymentFixtures";
import { surgePricingService } from "../../src/modules/pricing/services/surgePricing.service";
import { ridesRepository } from "../../src/modules/rides/repositories/rides.repository";
import { computeFare } from "../../src/modules/rides/services/fare.service";

const app = createApp();
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const P = { lat: 12.9716, lng: 77.5946, address: "MG Road, Bangalore" };
const D = { lat: 12.935, lng: 77.6245, address: "Koramangala, Bangalore" };
let vt: string;
const setSurge = (on: boolean) => { (env as { SURGE_ENABLED: string }).SURGE_ENABLED = on ? "true" : "false"; };

const requestRide = async (rider: { accessToken: string }) =>
  request(app).post("/api/rides/request").set(bearer(rider.accessToken)).send({ pickup: P, dropoff: D, vehicleTypeId: vt, idempotencyKey: idemKey() });

describe("Surge pricing (live DB + Redis)", () => {
  beforeAll(async () => { vt = await ensurePaymentVehicleType("SURGE_TEST"); });
  beforeEach(async () => { await resetPaymentTables(); await redis.flushdb(); setSurge(true); });
  afterEach(() => { setSurge(false); jest.restoreAllMocks(); });
  afterAll(async () => { await closeTestDb(); redis.disconnect(); });

  it("quotes 1.0x on a quiet map and counts the request being priced as demand", async () => {
    const q = await surgePricingService.quote(P, vt);
    expect(q).toMatchObject({ multiplier: 1, demand: 1, supply: 0 });
  });

  it("demand rises with open requests: the 3rd rider with no drivers nearby is quoted 1.5x and the ride stores it", async () => {
    const r1 = await registerUser(app, ["RIDER"]);
    const r2 = await registerUser(app, ["RIDER"]);
    const r3 = await registerUser(app, ["RIDER"]);
    expect((await requestRide(r1)).body.data.ride.surgeMultiplier).toBe(1);
    expect((await requestRide(r2)).body.data.ride.surgeMultiplier).toBe(1);
    const third = await requestRide(r3);
    expect(third.status).toBe(201);
    expect(third.body.data.ride.surgeMultiplier).toBe(1.5);
    expect(Number((await pool.query(`SELECT surge_multiplier FROM rides WHERE id = $1`, [third.body.data.ride.id])).rows[0].surge_multiplier)).toBe(1.5);
  });

  it("the estimate endpoint shows the same surge and a correspondingly higher fare", async () => {
    const riders = await Promise.all([1, 2].map(() => registerUser(app, ["RIDER"])));
    for (const r of riders) await requestRide(r);
    const viewer = await registerUser(app, ["RIDER"]);
    const est = await request(app).post("/api/rides/estimate").set(bearer(viewer.accessToken)).send({ pickup: P, dropoff: D, vehicleTypeId: vt });
    expect(est.status).toBe(200);
    expect(est.body.data.surge).toMatchObject({ multiplier: 1.5, demand: 3, supply: 0 });
    setSurge(false);
    const base = await request(app).post("/api/rides/estimate").set(bearer(viewer.accessToken)).send({ pickup: P, dropoff: D, vehicleTypeId: vt });
    expect(est.body.data.fare.totalFare).toBeGreaterThan(base.body.data.fare.totalFare);
    expect(est.body.data.fare.surgeMultiplier).toBe(1.5);
  });

  it("available drivers nearby bring the multiplier back down", async () => {
    const admin = await makeAdmin(app);
    const riders = await Promise.all([1, 2].map(() => registerUser(app, ["RIDER"])));
    for (const r of riders) await requestRide(r);
    expect((await surgePricingService.quote(P, vt)).multiplier).toBe(1.5); // 3 demand, 0 drivers

    const drivers = [];
    for (let i = 0; i < 3; i++) {
      const d = await readyDriver(app, vt, admin.accessToken);
      const ping = await request(app).post("/api/location/drivers/me").set(bearer(d.accessToken)).send({ lat: P.lat, lng: P.lng });
      expect(ping.status).toBeLessThan(300);
      drivers.push(d);
    }
    const q = await surgePricingService.quote(P, vt);
    expect(q.supply).toBe(3);
    expect(q.multiplier).toBe(1); // ratio 1.0: back to normal
  });

  it("requests far away do not count as local demand", async () => {
    const r = await registerUser(app, ["RIDER"]);
    await requestRide(r);
    expect(await ridesRepository.countSearchingNear({ lat: 13.9, lng: 77.5946 }, vt, 5000)).toBe(0);
    expect(await ridesRepository.countSearchingNear(P, vt, 5000)).toBe(1);
  });

  it("a surge lookup failure degrades to 1.0x instead of failing the booking", async () => {
    jest.spyOn(ridesRepository, "countSearchingNear").mockRejectedValue(new Error("db down"));
    const rider = await registerUser(app, ["RIDER"]);
    const res = await requestRide(rider);
    expect(res.status).toBe(201);
    expect(res.body.data.ride.surgeMultiplier).toBe(1);
  });

  it("SURGE_ENABLED=false always quotes 1.0x", async () => {
    setSurge(false);
    for (let i = 0; i < 4; i++) await requestRide(await registerUser(app, ["RIDER"]));
    expect((await surgePricingService.quote(P, vt)).multiplier).toBe(1);
  });

  it("the trip's final fare uses the multiplier locked at request time, not a fresh one", async () => {
    setSurge(false);
    const admin = await makeAdmin(app);
    const driver = await readyDriver(app, vt, admin.accessToken);
    const rider = await registerUser(app, ["RIDER"]);
    const rideId = (await requestRide(rider)).body.data.ride.id as string;
    await pool.query(`UPDATE rides SET surge_multiplier = 2.0 WHERE id = $1`, [rideId]);
    for (const step of ["accept", "arriving", "arrived", "start", "complete"]) {
      const r = await request(app).post(`/api/rides/${rideId}/${step}`).set(bearer(driver.accessToken));
      expect(r.status).toBeLessThan(400);
    }
    const fare = (await pool.query(`SELECT * FROM ride_fares WHERE ride_id = $1`, [rideId])).rows[0];
    const ride = (await pool.query(`SELECT distance_meters, duration_seconds FROM rides WHERE id = $1`, [rideId])).rows[0];
    const rates = (await pool.query(`SELECT base_fare, per_km_rate, per_min_rate FROM vehicle_types WHERE id = $1`, [vt])).rows[0];
    expect(Number(fare.surge_multiplier)).toBe(2);
    const expected = computeFare(ride.distance_meters, ride.duration_seconds, { baseFare: Number(rates.base_fare), perKmRate: Number(rates.per_km_rate), perMinRate: Number(rates.per_min_rate) }, { surgeMultiplier: 2 });
    expect(Number(fare.total_fare)).toBe(expected.totalFare);
  });

  it("the database refuses a multiplier below 1 or above 5", async () => {
    const rider = await registerUser(app, ["RIDER"]);
    const rideId = (await requestRide(rider)).body.data.ride.id as string;
    await expect(pool.query(`UPDATE rides SET surge_multiplier = 0.5 WHERE id = $1`, [rideId])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`UPDATE rides SET surge_multiplier = 9 WHERE id = $1`, [rideId])).rejects.toMatchObject({ code: "23514" });
  });
});

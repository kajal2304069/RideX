import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";

const app = createApp();
let vehicleTypeId: string;

const PICKUP = { lat: 12.9716, lng: 77.5946 }; // MG Road

async function resetTables() {
  await pool.query(
    `TRUNCATE ride_fares, rides, vehicle_driver_assignments, vehicles, drivers, riders, refresh_tokens, users RESTART IDENTITY CASCADE`
  );
  await redis.flushdb();
}

async function ensureVehicleType() {
  const { rows } = await pool.query(
    `INSERT INTO vehicle_types (code, display_name, base_fare, per_km_rate, per_min_rate)
     VALUES ('MATCH_TEST_SEDAN', 'Test Sedan', 50, 13, 1.5)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`
  );
  vehicleTypeId = rows[0].id;
}

async function registerAndLogin(roles: string[]) {
  const email = `match-${Date.now()}-${Math.random().toString(36).slice(2)}@ridex.dev`;
  const res = await request(app).post("/api/auth/register").send({
    email,
    password: "Passw0rd123",
    fullName: "Matching Test User",
    roles,
  });
  return { userId: res.body.data.user.id, accessToken: res.body.data.accessToken, email };
}

async function promoteToAdmin(userId: string) {
  await pool.query(`UPDATE users SET roles = array_append(roles, 'ADMIN') WHERE id = $1`, [userId]);
}

/** Sets up a fully ready (verified, assigned, online) driver at a specific location, optionally with a custom rating. */
async function readyDriverAt(lat: number, lng: number, ratingAvg?: number) {
  const owner = await registerAndLogin(["VEHICLE_OWNER"]);
  const vehicleRes = await request(app)
    .post("/api/vehicles")
    .set("Authorization", `Bearer ${owner.accessToken}`)
    .send({
      vehicleTypeId,
      registrationNumber: `KA-MATCH-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      brand: "Toyota",
      model: "Corolla",
      year: 2022,
    });
  const vehicleId = vehicleRes.body.data.vehicle.id;

  const driver = await registerAndLogin(["DRIVER"]);
  await request(app)
    .post("/api/drivers/onboard")
    .set("Authorization", `Bearer ${driver.accessToken}`)
    .send({ licenseNumber: `DL-MATCH-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, licenseExpiry: "2030-06-30" });

  const admin = await registerAndLogin(["RIDER"]);
  await promoteToAdmin(admin.userId);
  const adminLogin = await request(app).post("/api/auth/login").send({ email: admin.email, password: "Passw0rd123" });
  await request(app)
    .patch(`/api/drivers/${driver.userId}/verification`)
    .set("Authorization", `Bearer ${adminLogin.body.data.accessToken}`)
    .send({ status: "VERIFIED" });

  await request(app)
    .post(`/api/vehicles/${vehicleId}/assign-driver`)
    .set("Authorization", `Bearer ${owner.accessToken}`)
    .send({ driverId: driver.userId, commissionPercent: 20, ownerSharePercent: 80 });

  await request(app).post("/api/drivers/online").set("Authorization", `Bearer ${driver.accessToken}`);
  await request(app)
    .post("/api/location/drivers/me")
    .set("Authorization", `Bearer ${driver.accessToken}`)
    .send({ lat, lng });

  if (ratingAvg !== undefined) {
    await pool.query(`UPDATE drivers SET rating_avg = $2 WHERE user_id = $1`, [driver.userId, ratingAvg]);
  }

  return { driver, vehicleId, owner };
}

async function requestRide(riderToken: string, pickup = PICKUP) {
  const res = await request(app)
    .post("/api/rides/request")
    .set("Authorization", `Bearer ${riderToken}`)
    .send({
      pickup: { ...pickup, address: "Test pickup" },
      dropoff: { lat: 12.935, lng: 77.6245, address: "Test dropoff" },
      vehicleTypeId,
      idempotencyKey: `match-idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    });
  return res.body.data.ride.id as string;
}

describe("Matching module (live Redis + Postgres)", () => {
  beforeAll(ensureVehicleType);
  beforeEach(resetTables);
  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  it("ranks a closer driver above a farther one within the same search tier", async () => {
    const rider = await registerAndLogin(["RIDER"]);
    const rideId = await requestRide(rider.accessToken);

    // Both drivers within the first 1km tier, so the search stops at that
    // tier and both are compared - this isolates ranking order from
    // radius-tier expansion (tested separately below).
    const { driver: closeDriver } = await readyDriverAt(12.9726, 77.5946, 4.5); // ~110m away
    const { driver: farDriver } = await readyDriverAt(12.978, 77.5946, 4.5); // ~700m away, still within 1km

    const res = await request(app)
      .get(`/api/matching/rides/${rideId}/candidates`)
      .set("Authorization", `Bearer ${rider.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.searchRadiusMeters).toBe(1000);
    const ids = res.body.data.candidates.map((c: { driverId: string }) => c.driverId);
    expect(ids).toContain(closeDriver.userId);
    expect(ids).toContain(farDriver.userId);
    expect(ids.indexOf(closeDriver.userId)).toBeLessThan(ids.indexOf(farDriver.userId));
  });

  it("expands the search radius when no candidates exist at 1km, finding one at 2km", async () => {
    const rider = await registerAndLogin(["RIDER"]);
    const rideId = await requestRide(rider.accessToken);

    // ~1.5km away - outside the first 1km tier, inside the 2km tier
    await readyDriverAt(12.985, 77.5946, 4.5);

    const res = await request(app)
      .get(`/api/matching/rides/${rideId}/candidates`)
      .set("Authorization", `Bearer ${rider.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.searchRadiusMeters).toBe(2000);
    expect(res.body.data.candidatesFound).toBe(1);
  });

  it("returns zero candidates (not an error) when nobody is within any radius tier", async () => {
    const rider = await registerAndLogin(["RIDER"]);
    const rideId = await requestRide(rider.accessToken);

    const res = await request(app)
      .get(`/api/matching/rides/${rideId}/candidates`)
      .set("Authorization", `Bearer ${rider.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.candidatesFound).toBe(0);
    expect(res.body.data.searchRadiusMeters).toBe(10000); // exhausted every tier
  });

  it("excludes a driver who already has an active ride, even though they're nearby and online", async () => {
    const riderA = await registerAndLogin(["RIDER"]);
    const rideA = await requestRide(riderA.accessToken);
    const { driver: busyDriver } = await readyDriverAt(12.9726, 77.5946);
    await request(app).post(`/api/rides/${rideA}/accept`).set("Authorization", `Bearer ${busyDriver.accessToken}`);

    const riderB = await registerAndLogin(["RIDER"]);
    const rideB = await requestRide(riderB.accessToken);

    const res = await request(app)
      .get(`/api/matching/rides/${rideB}/candidates`)
      .set("Authorization", `Bearer ${riderB.accessToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.candidates.map((c: { driverId: string }) => c.driverId);
    expect(ids).not.toContain(busyDriver.userId);
  });

  it("rejects finding candidates for a ride that's already been accepted", async () => {
    const rider = await registerAndLogin(["RIDER"]);
    const rideId = await requestRide(rider.accessToken);
    const { driver } = await readyDriverAt(12.9726, 77.5946);
    await request(app).post(`/api/rides/${rideId}/accept`).set("Authorization", `Bearer ${driver.accessToken}`);

    const res = await request(app)
      .get(`/api/matching/rides/${rideId}/candidates`)
      .set("Authorization", `Bearer ${rider.accessToken}`);

    expect(res.status).toBe(409);
  });

  it("hides candidate results from someone who isn't the ride's rider (or an admin)", async () => {
    const rider = await registerAndLogin(["RIDER"]);
    const rideId = await requestRide(rider.accessToken);
    await readyDriverAt(12.9726, 77.5946);

    const stranger = await registerAndLogin(["RIDER"]);
    const res = await request(app)
      .get(`/api/matching/rides/${rideId}/candidates`)
      .set("Authorization", `Bearer ${stranger.accessToken}`);

    expect(res.status).toBe(404);
  });

  it("allows an admin to view candidates for any ride", async () => {
    const rider = await registerAndLogin(["RIDER"]);
    const rideId = await requestRide(rider.accessToken);
    await readyDriverAt(12.9726, 77.5946);

    const admin = await registerAndLogin(["RIDER"]);
    await promoteToAdmin(admin.userId);
    const adminLogin = await request(app).post("/api/auth/login").send({ email: admin.email, password: "Passw0rd123" });

    const res = await request(app)
      .get(`/api/matching/rides/${rideId}/candidates`)
      .set("Authorization", `Bearer ${adminLogin.body.data.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.candidatesFound).toBe(1);
  });

  it("includes a full score breakdown for each candidate", async () => {
    const rider = await registerAndLogin(["RIDER"]);
    const rideId = await requestRide(rider.accessToken);
    await readyDriverAt(12.9726, 77.5946, 4.2);

    const res = await request(app)
      .get(`/api/matching/rides/${rideId}/candidates`)
      .set("Authorization", `Bearer ${rider.accessToken}`);

    const candidate = res.body.data.candidates[0];
    expect(candidate.scoreBreakdown).toHaveProperty("distanceScore");
    expect(candidate.scoreBreakdown).toHaveProperty("etaScore");
    expect(candidate.scoreBreakdown).toHaveProperty("ratingScore");
    expect(candidate.ratingAvg).toBe(4.2);
  });
});

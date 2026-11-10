import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { closeTestDb } from "../integration/testUtils";
import { redis } from "../../src/config/redis";

const app = createApp();
let vehicleTypeId: string;

async function resetTables() {
  await pool.query(
    `TRUNCATE ride_fares, rides, vehicle_driver_assignments, vehicles, drivers, riders, refresh_tokens, users RESTART IDENTITY CASCADE`
  );
}

async function ensureVehicleType() {
  const { rows } = await pool.query(
    `INSERT INTO vehicle_types (code, display_name, base_fare, per_km_rate, per_min_rate)
     VALUES ('RIDE_CONC_SEDAN', 'Test Sedan', 50, 13, 1.5)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`
  );
  vehicleTypeId = rows[0].id;
}

async function registerAndLogin(roles: string[]) {
  const email = `rideconc-${Date.now()}-${Math.random().toString(36).slice(2)}@ridex.dev`;
  const res = await request(app).post("/api/auth/register").send({
    email,
    password: "Passw0rd123",
    fullName: "Ride Concurrency Test",
    roles,
  });
  return { userId: res.body.data.user.id, accessToken: res.body.data.accessToken, email };
}

async function promoteToAdmin(userId: string) {
  await pool.query(`UPDATE users SET roles = array_append(roles, 'ADMIN') WHERE id = $1`, [userId]);
}

async function readyDriver() {
  const owner = await registerAndLogin(["VEHICLE_OWNER"]);
  const vehicleRes = await request(app)
    .post("/api/vehicles")
    .set("Authorization", `Bearer ${owner.accessToken}`)
    .send({
      vehicleTypeId,
      registrationNumber: `KA-RC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      brand: "Toyota",
      model: "Corolla",
      year: 2022,
    });
  const vehicleId = vehicleRes.body.data.vehicle.id;

  const driver = await registerAndLogin(["DRIVER"]);
  await request(app)
    .post("/api/drivers/onboard")
    .set("Authorization", `Bearer ${driver.accessToken}`)
    .send({ licenseNumber: `DL-RC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, licenseExpiry: "2030-06-30" });

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

  return { driver, vehicleId };
}

/**
 * Spec section 12, verbatim scenario:
 *
 *   "Three drivers receive the same ride. Driver A, Driver B, Driver C.
 *   All try to accept at nearly the same time. Only ONE must succeed."
 *
 * This is the whole reason `acceptRideIfSearching` uses `SELECT ... FOR
 * UPDATE` (see rides.repository.ts) instead of a plain conditional
 * UPDATE like the vehicle-status optimistic-concurrency approach
 * (Phase 5) - ride acceptance is exactly the high-stakes, must-not-
 * double-assign case pessimistic locking exists for.
 */
describe("Concurrency: three drivers racing to accept one ride (spec section 12)", () => {
  beforeAll(ensureVehicleType);
  beforeEach(resetTables);
  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  it("allows exactly one of three simultaneous accept requests to succeed", async () => {
    const rider = await registerAndLogin(["RIDER"]);
    const rideRes = await request(app)
      .post("/api/rides/request")
      .set("Authorization", `Bearer ${rider.accessToken}`)
      .send({
        pickup: { lat: 12.9716, lng: 77.5946, address: "MG Road" },
        dropoff: { lat: 12.935, lng: 77.6245, address: "Koramangala" },
        vehicleTypeId,
        idempotencyKey: `idem-conc-${Date.now()}`,
      });
    const rideId = rideRes.body.data.ride.id;

    const [driverA, driverB, driverC] = await Promise.all([readyDriver(), readyDriver(), readyDriver()]);

    const accept = (driver: { accessToken: string }) =>
      request(app).post(`/api/rides/${rideId}/accept`).set("Authorization", `Bearer ${driver.accessToken}`);

    // Fire all three accept attempts essentially simultaneously.
    const [resA, resB, resC] = await Promise.all([accept(driverA.driver), accept(driverB.driver), accept(driverC.driver)]);

    const statuses = [resA.status, resB.status, resC.status];
    const successCount = statuses.filter((s) => s === 200).length;
    const conflictCount = statuses.filter((s) => s === 409).length;

    // Exactly one winner, two clean conflicts - never a partial/ambiguous
    // outcome, and never a leaked 500 (the FOR UPDATE lock means the two
    // losers' SELECTs simply see the already-updated status once they
    // get the lock, producing a clean, expected 409 - not a raw DB
    // constraint violation the way Phase 5's optimistic-check race did
    // before that fix).
    expect(successCount).toBe(1);
    expect(conflictCount).toBe(2);

    // The database is the ultimate judge: exactly one driver_id must be set.
    const { rows } = await pool.query(`SELECT driver_id, status FROM rides WHERE id = $1`, [rideId]);
    expect(rows[0].status).toBe("DRIVER_ASSIGNED");
    expect(rows[0].driver_id).not.toBeNull();

    // The winning HTTP response's driver ID must match the DB's winner -
    // proving the "one true winner" the DB recorded is the SAME one the
    // client that got a 200 was told won (no split-brain between what
    // the API reported and what was actually persisted).
    const winningResponse = [resA, resB, resC].find((r) => r.status === 200)!;
    expect(winningResponse.body.data.ride.driverId).toBe(rows[0].driver_id);

    // Both losing vehicles must remain AVAILABLE (never touched), and
    // only the winner's vehicle should have flipped to IN_RIDE_SERVICE.
    const winnerVehicleId = [driverA, driverB, driverC].find(
      (d) => d.driver.userId === rows[0].driver_id
    )!.vehicleId;
    const loserVehicleIds = [driverA, driverB, driverC]
      .filter((d) => d.driver.userId !== rows[0].driver_id)
      .map((d) => d.vehicleId);

    const winnerVehicle = await pool.query(`SELECT status FROM vehicles WHERE id = $1`, [winnerVehicleId]);
    expect(winnerVehicle.rows[0].status).toBe("IN_RIDE_SERVICE");

    for (const loserVehicleId of loserVehicleIds) {
      const loserVehicle = await pool.query(`SELECT status FROM vehicles WHERE id = $1`, [loserVehicleId]);
      expect(loserVehicle.rows[0].status).toBe("AVAILABLE");
    }
  });

  it("repeats the race 5 times to build confidence beyond a single lucky pass", async () => {
    for (let trial = 0; trial < 5; trial++) {
      await resetTables();

      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app)
        .post("/api/rides/request")
        .set("Authorization", `Bearer ${rider.accessToken}`)
        .send({
          pickup: { lat: 12.9716, lng: 77.5946, address: "MG Road" },
          dropoff: { lat: 12.935, lng: 77.6245, address: "Koramangala" },
          vehicleTypeId,
          idempotencyKey: `idem-conc-trial-${trial}-${Date.now()}`,
        });
      const rideId = rideRes.body.data.ride.id;

      const drivers = await Promise.all([readyDriver(), readyDriver(), readyDriver()]);
      const results = await Promise.all(
        drivers.map((d) =>
          request(app).post(`/api/rides/${rideId}/accept`).set("Authorization", `Bearer ${d.driver.accessToken}`)
        )
      );

      const successCount = results.filter((r) => r.status === 200).length;
      expect(successCount).toBe(1);
    }
  });
});

import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { closeTestDb } from "../integration/testUtils";
import { redis } from "../../src/config/redis";

const app = createApp();
let vehicleTypeId: string;

async function resetTables() {
  await pool.query(
    `TRUNCATE vehicle_driver_assignments, vehicles, drivers, riders, refresh_tokens, users RESTART IDENTITY CASCADE`
  );
}

async function ensureVehicleType() {
  const { rows } = await pool.query(
    `INSERT INTO vehicle_types (code, display_name) VALUES ('CONC_TEST_TYPE', 'Test')
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`
  );
  vehicleTypeId = rows[0].id;
}

async function registerAndLogin(roles: string[]) {
  const email = `conc-${Date.now()}-${Math.random().toString(36).slice(2)}@ridex.dev`;
  const res = await request(app).post("/api/auth/register").send({
    email,
    password: "Passw0rd123",
    fullName: "Concurrency Test User",
    roles,
  });
  return { userId: res.body.data.user.id, accessToken: res.body.data.accessToken, email };
}

async function promoteToAdmin(userId: string) {
  await pool.query(`UPDATE users SET roles = array_append(roles, 'ADMIN') WHERE id = $1`, [userId]);
}

async function verifiedDriver() {
  const driver = await registerAndLogin(["DRIVER"]);
  await request(app)
    .post("/api/drivers/onboard")
    .set("Authorization", `Bearer ${driver.accessToken}`)
    .send({ licenseNumber: `DL-CONC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, licenseExpiry: "2030-06-30" });

  const admin = await registerAndLogin(["RIDER"]);
  await promoteToAdmin(admin.userId);
  const adminLogin = await request(app).post("/api/auth/login").send({ email: admin.email, password: "Passw0rd123" });

  await request(app)
    .patch(`/api/drivers/${driver.userId}/verification`)
    .set("Authorization", `Bearer ${adminLogin.body.data.accessToken}`)
    .send({ status: "VERIFIED" });

  return driver;
}

/**
 * Spec section 12's concurrency scenario, applied to vehicle-driver
 * assignment instead of ride acceptance: TWO different verified drivers
 * are assigned to the SAME vehicle at (as close as possible to)
 * literally the same instant. Exactly ONE must win; the DB's partial
 * unique index (`vehicle_driver_assignments_one_active_per_vehicle`,
 * Phase 3) is the actual, non-bypassable guarantee - the service-layer
 * "check then insert" is necessarily racy on its own (classic TOCTOU:
 * both requests can pass the "no active assignment" check before either
 * commits), so this test also validates the DB constraint is what
 * ultimately saves us, not the application check.
 */
describe("Concurrency: two drivers racing for one vehicle", () => {
  beforeAll(ensureVehicleType);
  beforeEach(resetTables);
  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  it("allows exactly one of two concurrent assign-driver requests to succeed", async () => {
    const owner = await registerAndLogin(["VEHICLE_OWNER"]);
    const vehicleRes = await request(app)
      .post("/api/vehicles")
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({
        vehicleTypeId,
        registrationNumber: `KA-CONC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        brand: "Toyota",
        model: "Corolla",
        year: 2022,
      });
    const vehicleId = vehicleRes.body.data.vehicle.id;

    const [driverA, driverB] = await Promise.all([verifiedDriver(), verifiedDriver()]);

    const assign = (driverId: string) =>
      request(app)
        .post(`/api/vehicles/${vehicleId}/assign-driver`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ driverId, commissionPercent: 20, ownerSharePercent: 80 });

    // Fire both requests essentially simultaneously.
    const [resA, resB] = await Promise.all([assign(driverA.userId), assign(driverB.userId)]);

    const statuses = [resA.status, resB.status].sort();
    // Exactly one 201 (success) and one clean 409 (conflict) - never a
    // leaked 500. This is the actual regression this test caught: the
    // very first run of this test observed the loser getting an
    // unhandled 500 (a raw Postgres unique_violation bubbling past the
    // service layer), which is now fixed in vehicles.service.ts.
    expect(statuses).toEqual([201, 409]);

    const successCount = [resA.status, resB.status].filter((s) => s === 201).length;
    expect(successCount).toBe(1);

    // The DB is the ultimate source of truth: only one ACTIVE assignment
    // must exist for this vehicle, no matter how the HTTP layer reported it.
    const { rows } = await pool.query(
      `SELECT count(*) FROM vehicle_driver_assignments WHERE vehicle_id = $1 AND status = 'ACTIVE'`,
      [vehicleId]
    );
    expect(Number(rows[0].count)).toBe(1);

    // The vehicle's current_driver_id must match whichever assignment
    // actually won, not be left null or pointing at the loser.
    const vehicleRow = await pool.query(`SELECT current_driver_id FROM vehicles WHERE id = $1`, [vehicleId]);
    const winnerId = resA.status === 201 ? driverA.userId : driverB.userId;
    expect(vehicleRow.rows[0].current_driver_id).toBe(winnerId);

    expect(statuses[0]).not.toBe(statuses[1]); // sanity: not both identical outcomes
  });
});

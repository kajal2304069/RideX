import request from "supertest";
import { Application } from "express";
import { pool } from "../../src/db/pool";

export async function resetPaymentTables() {
  await pool.query(
    `TRUNCATE payments, ride_fares, rides, vehicle_driver_assignments, vehicles, drivers, riders, refresh_tokens, users RESTART IDENTITY CASCADE`
  );
}

export async function ensurePaymentVehicleType(code: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO vehicle_types (code, display_name, base_fare, per_km_rate, per_min_rate)
     VALUES ($1, 'Test Sedan', 50, 13, 1.5)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    [code]
  );
  return rows[0].id;
}

export async function registerUser(app: Application, roles: string[]) {
  const email = `pay-${Date.now()}-${Math.random().toString(36).slice(2)}@ridex.dev`;
  const res = await request(app).post("/api/auth/register").send({ email, password: "Passw0rd123", fullName: "Payment Test User", roles });
  return { userId: res.body.data.user.id as string, accessToken: res.body.data.accessToken as string, email };
}

export async function makeAdmin(app: Application) {
  const admin = await registerUser(app, ["RIDER"]);
  await pool.query(`UPDATE users SET roles = array_append(roles, 'ADMIN') WHERE id = $1`, [admin.userId]);
  const login = await request(app).post("/api/auth/login").send({ email: admin.email, password: "Passw0rd123" });
  return { userId: admin.userId, accessToken: login.body.data.accessToken as string };
}

/** Onboards a verified, online driver with an assigned vehicle. */
export async function readyDriver(app: Application, vehicleTypeId: string, adminToken: string) {
  const owner = await registerUser(app, ["VEHICLE_OWNER"]);
  const vehicleRes = await request(app)
    .post("/api/vehicles")
    .set("Authorization", `Bearer ${owner.accessToken}`)
    .send({
      vehicleTypeId,
      registrationNumber: `KA-PAY-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      brand: "Toyota",
      model: "Corolla",
      year: 2022,
    });
  const vehicleId = vehicleRes.body.data.vehicle.id;

  const driver = await registerUser(app, ["DRIVER"]);
  await request(app)
    .post("/api/drivers/onboard")
    .set("Authorization", `Bearer ${driver.accessToken}`)
    .send({ licenseNumber: `DL-PAY-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, licenseExpiry: "2030-06-30" });
  await request(app)
    .patch(`/api/drivers/${driver.userId}/verification`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ status: "VERIFIED" });
  await request(app)
    .post(`/api/vehicles/${vehicleId}/assign-driver`)
    .set("Authorization", `Bearer ${owner.accessToken}`)
    .send({ driverId: driver.userId, commissionPercent: 20, ownerSharePercent: 80 });
  await request(app).post("/api/drivers/online").set("Authorization", `Bearer ${driver.accessToken}`);
  return driver;
}

/**
 * Drives a brand-new ride through the whole lifecycle up to TRIP_COMPLETED,
 * which is the state a ride must be in before it can be paid.
 */
export async function createCompletedRide(app: Application, vehicleTypeId: string, admin: { accessToken: string }) {
  const driver = await readyDriver(app, vehicleTypeId, admin.accessToken);
  const rider = await registerUser(app, ["RIDER"]);

  const rideRes = await request(app)
    .post("/api/rides/request")
    .set("Authorization", `Bearer ${rider.accessToken}`)
    .send({
      pickup: { lat: 12.9716, lng: 77.5946, address: "MG Road, Bangalore" },
      dropoff: { lat: 12.935, lng: 77.6245, address: "Koramangala, Bangalore" },
      vehicleTypeId,
      idempotencyKey: `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    });
  const rideId = rideRes.body.data.ride.id as string;

  for (const step of ["accept", "arriving", "arrived", "start", "complete"]) {
    const r = await request(app).post(`/api/rides/${rideId}/${step}`).set("Authorization", `Bearer ${driver.accessToken}`);
    if (r.status >= 400) throw new Error(`Fixture failed at ${step}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return { rideId, rider, driver };
}

export function idemKey() {
  return `pay-key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

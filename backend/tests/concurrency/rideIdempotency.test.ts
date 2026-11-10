import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "../integration/testUtils";

const app = createApp();
let vehicleTypeId: string;

async function resetTables() {
  await pool.query(
    `TRUNCATE ride_fares, rides, vehicle_driver_assignments, vehicles, drivers, riders, refresh_tokens, users RESTART IDENTITY CASCADE`
  );
  await redis.flushdb();
}

async function ensureVehicleType() {
  const { rows } = await pool.query(
    `INSERT INTO vehicle_types (code, display_name, base_fare, per_km_rate, per_min_rate)
     VALUES ('IDEM_CONC_SEDAN', 'Test Sedan', 50, 13, 1.5)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`
  );
  vehicleTypeId = rows[0].id;
}

async function registerAndLogin() {
  const email = `idemconc-${Date.now()}-${Math.random().toString(36).slice(2)}@ridex.dev`;
  const res = await request(app).post("/api/auth/register").send({
    email,
    password: "Passw0rd123",
    fullName: "Idempotency Concurrency Test",
    roles: ["RIDER"],
  });
  return { userId: res.body.data.user.id, accessToken: res.body.data.accessToken };
}

/**
 * Spec section 13's idempotency requirement, stress-tested the way
 * spec section 12 asks concurrency guarantees to be stress-tested: fire
 * the SAME "create ride" request (same idempotency key) many times,
 * essentially simultaneously - simulating a flaky mobile client
 * retrying a request it wrongly believes timed out. Exactly ONE ride
 * may ever be created; every response (whichever request "wins" the
 * actual insert) must return the SAME ride ID.
 *
 * This is the scenario the Redis distributed lock added in Phase 11
 * exists to close - before that lock, this test would have exposed the
 * TOCTOU race described in rides.service.ts's request() method (and,
 * without the defense-in-depth unique-violation handling, could have
 * surfaced as a raw, unhandled 500 - the same class of bug Phase 5
 * found and fixed for vehicle assignment).
 */
describe("Concurrency: N simultaneous ride requests with the same idempotency key", () => {
  beforeAll(ensureVehicleType);
  beforeEach(resetTables);
  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  it("creates exactly one ride no matter how many identical concurrent requests arrive", async () => {
    const rider = await registerAndLogin();
    const idempotencyKey = `idem-conc-${Date.now()}`;
    const payload = {
      pickup: { lat: 12.9716, lng: 77.5946, address: "MG Road" },
      dropoff: { lat: 12.935, lng: 77.6245, address: "Koramangala" },
      vehicleTypeId,
      idempotencyKey,
    };

    const attempt = () =>
      request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send(payload);

    const responses = await Promise.all(Array.from({ length: 8 }, attempt));

    const rideIds = new Set(responses.map((r) => r.body?.data?.ride?.id));
    const statuses = responses.map((r) => r.status);

    expect(statuses.every((s) => s === 201)).toBe(true);
    expect(rideIds.size).toBe(1);

    const { rows } = await pool.query(`SELECT count(*) FROM rides WHERE idempotency_key = $1`, [idempotencyKey]);
    expect(Number(rows[0].count)).toBe(1);
  });

  it("repeats the race 3 times to build confidence beyond a single lucky pass", async () => {
    for (let trial = 0; trial < 3; trial++) {
      await resetTables();
      const rider = await registerAndLogin();
      const idempotencyKey = `idem-conc-trial-${trial}-${Date.now()}`;
      const payload = {
        pickup: { lat: 12.9716, lng: 77.5946, address: "MG Road" },
        dropoff: { lat: 12.935, lng: 77.6245, address: "Koramangala" },
        vehicleTypeId,
        idempotencyKey,
      };

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send(payload)
        )
      );

      const rideIds = new Set(responses.map((r) => r.body?.data?.ride?.id));
      expect(rideIds.size).toBe(1);
      expect(responses.every((r) => r.status === 201)).toBe(true);
    }
  });
});

import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "../integration/testUtils";
import { createCompletedRide, ensurePaymentVehicleType, idemKey, makeAdmin, resetPaymentTables } from "../integration/paymentFixtures";
import { MockPaymentProvider } from "../../src/modules/payments/services/providers/MockPaymentProvider";
import { setPaymentProviderForTests } from "../../src/modules/payments/services/providers";

const app = createApp();
const N = 10;
let vehicleTypeId: string;
let admin: { userId: string; accessToken: string };
let provider: MockPaymentProvider;

function pay(token: string, rideId: string, key: string) {
  return request(app)
    .post("/api/payments")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", key)
    .send({ payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });
}

/**
 * The money-critical scenario: a flaky client (or two devices) fires many
 * payment requests for the same ride at once. Exactly ONE charge may reach
 * the provider and exactly ONE payments row may exist.
 *
 * The mock provider is given 100ms of latency to widen the race window so
 * that, without the lock and the unique index, several requests would be
 * "in flight" at the same moment.
 */
describe("Concurrency: simultaneous payments for one ride", () => {
  beforeAll(async () => {
    vehicleTypeId = await ensurePaymentVehicleType("PAY_CONC_SEDAN");
  });
  beforeEach(async () => {
    await resetPaymentTables();
    await redis.flushdb();
    admin = await makeAdmin(app);
    provider = new MockPaymentProvider(100);
    setPaymentProviderForTests(provider);
  });
  afterAll(async () => {
    setPaymentProviderForTests(null);
    await closeTestDb();
    redis.disconnect();
  });

  it(`${N} requests with the SAME key -> one charge, one row, one payment id`, async () => {
    const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);
    const key = idemKey();

    const results = await Promise.all(Array.from({ length: N }, () => pay(rider.accessToken, rideId, key)));

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.data.payment.id)).size).toBe(1);
    expect(provider.chargeCalls).toBe(1);
    const rows = await pool.query(`SELECT status FROM payments`);
    expect(rows.rows).toEqual([{ status: "SUCCESS" }]);
  });

  it(`${N} requests with DIFFERENT keys -> exactly one wins, the rest are 409, one charge`, async () => {
    const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);

    const results = await Promise.all(Array.from({ length: N }, () => pay(rider.accessToken, rideId, idemKey())));

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(N - 1);
    expect(provider.chargeCalls).toBe(1);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM payments`);
    expect(rows.rows[0].n).toBe(1);
  });

  it("with Redis locking bypassed, the DB unique index alone still prevents a double payment", async () => {
    const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);

    // Simulate "lock expired / Redis unavailable" by going straight at the repository,
    // which is exactly what the service calls after acquiring the lock.
    const { paymentsRepository } = await import("../../src/modules/payments/repositories/payments.repository");
    const attempts = await Promise.allSettled(
      Array.from({ length: N }, () =>
        paymentsRepository.createPending({
          payableType: "RIDE",
          payableId: rideId,
          payerId: rider.userId,
          amount: 100,
          currency: "INR",
          provider: "mock",
          idempotencyKey: idemKey(),
        })
      )
    );

    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.filter((a): a is PromiseRejectedResult => a.status === "rejected");
    expect(rejected).toHaveLength(N - 1);
    expect(rejected.every((r) => r.reason.code === "23505")).toBe(true);
  });
});

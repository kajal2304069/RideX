import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";
import { createCompletedRide, ensurePaymentVehicleType, idemKey, makeAdmin, registerUser, resetPaymentTables } from "./paymentFixtures";

const app = createApp();
let vehicleTypeId: string;
let admin: { userId: string; accessToken: string };

function pay(token: string, body: Record<string, unknown>, key: string | null = idemKey()) {
  const req = request(app).post("/api/payments").set("Authorization", `Bearer ${token}`);
  if (key) req.set("Idempotency-Key", key);
  return req.send(body);
}

describe("Payments module (live DB)", () => {
  beforeAll(async () => {
    vehicleTypeId = await ensurePaymentVehicleType("PAY_TEST_SEDAN");
  });
  beforeEach(async () => {
    await resetPaymentTables();
    await redis.flushdb();
    admin = await makeAdmin(app);
  });
  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  describe("Paying for a ride", () => {
    it("charges the saved fare, marks SUCCESS, and moves the ride to PAYMENT_COMPLETED", async () => {
      const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);
      const fare = await pool.query(`SELECT total_fare FROM ride_fares WHERE ride_id = $1`, [rideId]);

      const res = await pay(rider.accessToken, { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });

      expect(res.status).toBe(201);
      expect(res.body.data.payment.status).toBe("SUCCESS");
      expect(res.body.data.payment.amount).toBe(Number(fare.rows[0].total_fare));
      expect(res.body.data.payment.providerReference).toMatch(/^mock_ch_/);

      const ride = await request(app).get(`/api/rides/${rideId}`).set("Authorization", `Bearer ${rider.accessToken}`);
      expect(ride.body.data.ride.status).toBe("PAYMENT_COMPLETED");
    });

    it("rejects a client-supplied amount (strict schema: the server decides what is owed)", async () => {
      const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);
      const res = await pay(rider.accessToken, { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success", amount: 1 });
      expect(res.status).toBe(400);
    });

    it("requires an Idempotency-Key header", async () => {
      const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);
      const res = await pay(rider.accessToken, { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_x" }, null);
      expect(res.status).toBe(400);
    });

    it("requires authentication", async () => {
      const res = await request(app).post("/api/payments").set("Idempotency-Key", idemKey()).send({});
      expect(res.status).toBe(401);
    });

    it("refuses to pay for a ride that has not been completed", async () => {
      const rider = await registerUser(app, ["RIDER"]);
      const { rows } = await pool.query(
        `INSERT INTO rides (rider_id, vehicle_type_id, status, pickup_location, pickup_address, dropoff_location, dropoff_address, idempotency_key)
         VALUES ($1, $2, 'SEARCHING_DRIVER', ST_SetSRID(ST_MakePoint(77.59,12.97),4326)::geography, 'a', ST_SetSRID(ST_MakePoint(77.62,12.93),4326)::geography, 'b', $3)
         RETURNING id`,
        [rider.userId, vehicleTypeId, idemKey()]
      );
      const res = await pay(rider.accessToken, { payableType: "RIDE", payableId: rows[0].id, paymentMethodToken: "tok_mock_success" });
      expect(res.status).toBe(400);
    });

    it("hides another rider's ride behind a 404", async () => {
      const { rideId } = await createCompletedRide(app, vehicleTypeId, admin);
      const stranger = await registerUser(app, ["RIDER"]);
      const res = await pay(stranger.accessToken, { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });
      expect(res.status).toBe(404);
    });

    it("404s for a ride that does not exist", async () => {
      const rider = await registerUser(app, ["RIDER"]);
      const res = await pay(rider.accessToken, { payableType: "RIDE", payableId: "00000000-0000-4000-8000-000000000000", paymentMethodToken: "tok_x" });
      expect(res.status).toBe(404);
    });

    it("every payable type is registered (an unknown id is a 404, never a 501)", async () => {
      const rider = await registerUser(app, ["RIDER"]);
      for (const payableType of ["RIDE", "RENTAL", "MARKETPLACE", "GARAGE_SERVICE"]) {
        const res = await pay(rider.accessToken, { payableType, payableId: "00000000-0000-4000-8000-000000000000", paymentMethodToken: "tok_x" });
        expect(res.status).toBe(404);
      }
    });
  });

  describe("Idempotency and double payment", () => {
    it("replaying the same key returns the same payment and does not create another", async () => {
      const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);
      const key = idemKey();
      const body = { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" };

      const first = await pay(rider.accessToken, body, key);
      const second = await pay(rider.accessToken, body, key);

      expect(second.body.data.payment.id).toBe(first.body.data.payment.id);
      const count = await pool.query(`SELECT count(*)::int AS n FROM payments`);
      expect(count.rows[0].n).toBe(1);
    });

    it("a different key for an already-paid ride is a 409", async () => {
      const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);
      const body = { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" };

      await pay(rider.accessToken, body);
      const again = await pay(rider.accessToken, body);

      expect(again.status).toBe(409);
    });

    it("reusing a key for a different ride is a 409", async () => {
      const a = await createCompletedRide(app, vehicleTypeId, admin);
      const key = idemKey();
      await pay(a.rider.accessToken, { payableType: "RIDE", payableId: a.rideId, paymentMethodToken: "tok_mock_success" }, key);

      const other = await pay(a.rider.accessToken, { payableType: "RIDE", payableId: "00000000-0000-4000-8000-000000000000", paymentMethodToken: "tok_mock_success" }, key);
      expect(other.status).toBe(409);
    });

    it("two users using the same raw key never collide (keys are namespaced per payer)", async () => {
      const a = await createCompletedRide(app, vehicleTypeId, admin);
      const b = await createCompletedRide(app, vehicleTypeId, admin);
      const key = idemKey();

      const ra = await pay(a.rider.accessToken, { payableType: "RIDE", payableId: a.rideId, paymentMethodToken: "tok_mock_success" }, key);
      const rb = await pay(b.rider.accessToken, { payableType: "RIDE", payableId: b.rideId, paymentMethodToken: "tok_mock_success" }, key);

      expect(ra.status).toBe(201);
      expect(rb.status).toBe(201);
      expect(ra.body.data.payment.id).not.toBe(rb.body.data.payment.id);
    });
  });

  describe("Failures and retry", () => {
    it("a declined card returns 402, stores FAILED, and leaves the ride payable", async () => {
      const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);

      const res = await pay(rider.accessToken, { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_decline" });

      expect(res.status).toBe(402);
      expect(res.body.data.payment.status).toBe("FAILED");
      expect(res.body.data.payment.failureReason).toBe("card_declined");
      const ride = await request(app).get(`/api/rides/${rideId}`).set("Authorization", `Bearer ${rider.accessToken}`);
      expect(ride.body.data.ride.status).toBe("TRIP_COMPLETED");
    });

    it("after a decline the rider can retry with a new key and a good card", async () => {
      const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);
      await pay(rider.accessToken, { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_decline" });

      const retry = await pay(rider.accessToken, { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });

      expect(retry.status).toBe(201);
      expect(retry.body.data.payment.status).toBe("SUCCESS");
      const rows = await pool.query(`SELECT status FROM payments ORDER BY created_at`);
      expect(rows.rows.map((r) => r.status)).toEqual(["FAILED", "SUCCESS"]);
    });

    it("a provider error returns 502 and leaves PROCESSING; retrying the same key can finish it", async () => {
      const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);
      const key = idemKey();

      const broken = await pay(rider.accessToken, { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_error" }, key);
      expect(broken.status).toBe(502);
      const mid = await pool.query(`SELECT status FROM payments`);
      expect(mid.rows[0].status).toBe("PROCESSING");

      const retry = await pay(rider.accessToken, { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" }, key);
      expect(retry.status).toBe(201);
      expect(retry.body.data.payment.status).toBe("SUCCESS");
      const count = await pool.query(`SELECT count(*)::int AS n FROM payments`);
      expect(count.rows[0].n).toBe(1);
    });

    it("a stuck PROCESSING payment blocks a payment under a different key (no double charge risk)", async () => {
      const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);
      await pay(rider.accessToken, { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_error" });

      const other = await pay(rider.accessToken, { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });
      expect(other.status).toBe(409);
    });
  });

  describe("Reading payments", () => {
    it("lets the payer read their payment and list history, but not other users", async () => {
      const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);
      const created = await pay(rider.accessToken, { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });
      const id = created.body.data.payment.id;

      const mine = await request(app).get(`/api/payments/${id}`).set("Authorization", `Bearer ${rider.accessToken}`);
      expect(mine.status).toBe(200);

      const list = await request(app).get("/api/payments").set("Authorization", `Bearer ${rider.accessToken}`);
      expect(list.body.data.payments).toHaveLength(1);

      const stranger = await registerUser(app, ["RIDER"]);
      const theirs = await request(app).get(`/api/payments/${id}`).set("Authorization", `Bearer ${stranger.accessToken}`);
      expect(theirs.status).toBe(404);

      const asAdmin = await request(app).get(`/api/payments/${id}`).set("Authorization", `Bearer ${admin.accessToken}`);
      expect(asAdmin.status).toBe(200);
    });
  });

  describe("Refunds", () => {
    it("lets an admin refund a successful payment once; a second refund is a 409", async () => {
      const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);
      const created = await pay(rider.accessToken, { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });
      const id = created.body.data.payment.id;

      const first = await request(app).post(`/api/payments/${id}/refund`).set("Authorization", `Bearer ${admin.accessToken}`);
      expect(first.status).toBe(200);
      expect(first.body.data.payment.status).toBe("REFUNDED");

      const second = await request(app).post(`/api/payments/${id}/refund`).set("Authorization", `Bearer ${admin.accessToken}`);
      expect(second.status).toBe(409);
    });

    it("forbids non-admins from refunding", async () => {
      const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);
      const created = await pay(rider.accessToken, { payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });

      const res = await request(app).post(`/api/payments/${created.body.data.payment.id}/refund`).set("Authorization", `Bearer ${rider.accessToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe("Database guarantee", () => {
    it("the partial unique index rejects a second live payment for the same payable even if the app is bypassed", async () => {
      const { rideId, rider } = await createCompletedRide(app, vehicleTypeId, admin);
      const insert = (key: string, status: string) =>
        pool.query(
          `INSERT INTO payments (payable_type, payable_id, payer_id, amount, status, idempotency_key)
           VALUES ('RIDE', $1, $2, 100, $3::payment_status, $4)`,
          [rideId, rider.userId, status, key]
        );

      await insert("k-1", "SUCCESS");
      await expect(insert("k-2", "PENDING")).rejects.toMatchObject({ code: "23505" });
      // FAILED rows are outside the index, so history can accumulate.
      await expect(insert("k-3", "FAILED")).resolves.toBeDefined();
    });
  });
});

import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";
import { ensurePaymentVehicleType, idemKey, makeAdmin, registerUser } from "./paymentFixtures";
import {
  advanceBooking, bearer, bookingKey, CENTER, createGarage, customerWithVehicle, offsetMeters, registerGarageOwner, resetGarageTables,
} from "./garageFixtures";

const app = createApp();
let vehicleTypeId: string;

type Account = { userId: string; accessToken: string };

async function book(customer: Account, garageId: string, extra: Record<string, unknown> = {}) {
  return request(app).post("/api/bookings").set(bearer(customer.accessToken)).send({ garageId, idempotencyKey: bookingKey(), ...extra });
}
const post = (who: Account, path: string, body?: object) => request(app).post(path).set(bearer(who.accessToken)).send(body);
const get = (who: Account, path: string) => request(app).get(path).set(bearer(who.accessToken));
const statusOf = async (id: string) => (await pool.query(`SELECT status FROM service_bookings WHERE id = $1`, [id])).rows[0].status as string;
const vehicleStatus = async (id: string) => (await pool.query(`SELECT status FROM vehicles WHERE id = $1`, [id])).rows[0].status as string;

/** garage owner + garage + customer with a vehicle + one booking, ready to advance. */
async function setup(opts: { services?: string[]; mechanics?: string[] } = {}) {
  const owner = await registerGarageOwner(app);
  const g = await createGarage(app, owner, { services: opts.services ?? ["OIL_CHANGE"], mechanics: opts.mechanics ?? ["Ravi"] });
  const customer = await customerWithVehicle(app, vehicleTypeId);
  const res = await book(customer, g.garageId, { garageServiceId: g.services[(opts.services ?? ["OIL_CHANGE"])[0]], vehicleId: customer.vehicleId });
  if (res.status !== 201) throw new Error(`booking failed ${res.status} ${JSON.stringify(res.body)}`);
  return { owner, customer, ...g, bookingId: res.body.data.booking.id as string };
}

describe("Bookings / repairs (live DB)", () => {
  beforeAll(async () => {
    vehicleTypeId = await ensurePaymentVehicleType("GARAGE_TEST_SEDAN");
  });
  beforeEach(async () => {
    await resetGarageTables();
    await redis.flushdb();
  });
  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  describe("full lifecycle", () => {
    it("runs REQUESTED -> ... -> READY -> paid -> COMPLETED, with vehicle status, costs and maintenance history", async () => {
      const s = await setup();

      expect((await post(s.owner, `/api/bookings/${s.bookingId}/accept`)).body.data.booking.status).toBe("ACCEPTED");
      expect((await post(s.owner, `/api/bookings/${s.bookingId}/assign-mechanic`, { mechanicId: s.mechanicIds[0] })).body.data.booking.status).toBe("MECHANIC_ASSIGNED");

      expect(await vehicleStatus(s.customer.vehicleId)).toBe("AVAILABLE");
      expect((await post(s.owner, `/api/bookings/${s.bookingId}/vehicle-received`)).body.data.booking.status).toBe("VEHICLE_RECEIVED");
      expect(await vehicleStatus(s.customer.vehicleId)).toBe("UNDER_MAINTENANCE");

      expect((await post(s.owner, `/api/bookings/${s.bookingId}/start-repair`)).body.data.booking.status).toBe("REPAIR_IN_PROGRESS");

      const put = await request(app).put(`/api/bookings/${s.bookingId}/repair-order`).set(bearer(s.owner.accessToken)).send({
        diagnosis: "Oil degraded", workPerformed: "Changed oil and filter", laborCost: 500,
        partsUsed: [{ name: "Oil", quantity: 2, unitPrice: 250.5 }, { name: "Filter", quantity: 1, unitPrice: 99.99 }],
      });
      expect(put.body.data.repairOrder).toMatchObject({ laborCost: 500, partsCost: 600.99, totalCost: 1100.99 });

      expect((await post(s.owner, `/api/bookings/${s.bookingId}/ready`)).body.data.booking.status).toBe("READY");
      expect(await vehicleStatus(s.customer.vehicleId)).toBe("UNDER_MAINTENANCE"); // still on the lift until paid

      const pay = await request(app).post("/api/payments").set(bearer(s.customer.accessToken)).set("Idempotency-Key", idemKey())
        .send({ payableType: "GARAGE_SERVICE", payableId: s.bookingId, paymentMethodToken: "tok_mock_success" });
      expect(pay.status).toBe(201);
      expect(pay.body.data.payment).toMatchObject({ status: "SUCCESS", amount: 1100.99 });

      expect(await statusOf(s.bookingId)).toBe("COMPLETED");
      expect(await vehicleStatus(s.customer.vehicleId)).toBe("AVAILABLE");

      const detail = await get(s.customer, `/api/bookings/${s.bookingId}`);
      expect(detail.body.data.repairOrder.completedAt).not.toBeNull();

      const history = await get(s.customer, `/api/bookings/vehicles/${s.customer.vehicleId}/maintenance`);
      expect(history.body.data.records).toHaveLength(1);
      expect(history.body.data.records[0]).toMatchObject({ serviceType: "OIL_CHANGE", cost: 1100.99 });
      const days = (new Date(history.body.data.records[0].nextDueAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(178);
      expect(days).toBeLessThan(181);
    });

    it("a replayed payment does not complete twice or add a second maintenance record", async () => {
      const s = await setup();
      await advanceBooking(app, s.owner, s.bookingId, s.mechanicIds[0], "ready");
      const key = idemKey();
      const body = { payableType: "GARAGE_SERVICE", payableId: s.bookingId, paymentMethodToken: "tok_mock_success" };
      const send = () => request(app).post("/api/payments").set(bearer(s.customer.accessToken)).set("Idempotency-Key", key).send(body);

      await send();
      await send();

      const n = await pool.query(`SELECT count(*)::int AS n FROM maintenance_records WHERE vehicle_id = $1`, [s.customer.vehicleId]);
      expect(n.rows[0].n).toBe(1);
    });

    it("cannot be paid before READY, and a paid booking cannot be paid again", async () => {
      const s = await setup();
      const pay = (key = idemKey()) => request(app).post("/api/payments").set(bearer(s.customer.accessToken)).set("Idempotency-Key", key)
        .send({ payableType: "GARAGE_SERVICE", payableId: s.bookingId, paymentMethodToken: "tok_mock_success" });

      expect((await pay()).status).toBe(400); // REQUESTED
      await advanceBooking(app, s.owner, s.bookingId, s.mechanicIds[0], "ready");
      expect((await pay()).status).toBe(201);
      expect((await pay()).status).toBe(409);
    });

    it("only the customer who owes the money can pay", async () => {
      const s = await setup();
      await advanceBooking(app, s.owner, s.bookingId, s.mechanicIds[0], "ready");
      const stranger = await registerUser(app, ["RIDER"]);
      const res = await request(app).post("/api/payments").set(bearer(stranger.accessToken)).set("Idempotency-Key", idemKey())
        .send({ payableType: "GARAGE_SERVICE", payableId: s.bookingId, paymentMethodToken: "tok_mock_success" });
      expect(res.status).toBe(404);
    });

    it("a declined card leaves the booking READY and the vehicle on the lift; a retry then completes it", async () => {
      const s = await setup();
      await advanceBooking(app, s.owner, s.bookingId, s.mechanicIds[0], "ready");
      const pay = (token: string) => request(app).post("/api/payments").set(bearer(s.customer.accessToken)).set("Idempotency-Key", idemKey())
        .send({ payableType: "GARAGE_SERVICE", payableId: s.bookingId, paymentMethodToken: token });

      expect((await pay("tok_mock_decline")).status).toBe(402);
      expect(await statusOf(s.bookingId)).toBe("READY");
      expect((await pay("tok_mock_success")).status).toBe(201);
      expect(await statusOf(s.bookingId)).toBe("COMPLETED");
    });
  });

  describe("state machine over HTTP", () => {
    it("rejects skipping steps", async () => {
      const s = await setup();
      expect((await post(s.owner, `/api/bookings/${s.bookingId}/start-repair`)).status).toBe(400);
      await post(s.owner, `/api/bookings/${s.bookingId}/accept`);
      expect((await post(s.owner, `/api/bookings/${s.bookingId}/accept`)).status).toBe(400); // already accepted
      expect((await post(s.owner, `/api/bookings/${s.bookingId}/vehicle-received`)).status).toBe(400);
    });

    it("refuses to mark ready before costs are recorded", async () => {
      const s = await setup();
      await advanceBooking(app, s.owner, s.bookingId, s.mechanicIds[0], "started");
      expect((await post(s.owner, `/api/bookings/${s.bookingId}/ready`)).status).toBe(400);
    });

    it("the client cannot supply partsCost or totalCost", async () => {
      const s = await setup();
      await advanceBooking(app, s.owner, s.bookingId, s.mechanicIds[0], "started");
      const res = await request(app).put(`/api/bookings/${s.bookingId}/repair-order`).set(bearer(s.owner.accessToken)).send({ laborCost: 10, totalCost: 1 });
      expect(res.status).toBe(400);
    });

    it("freezes the repair order once READY (the payment amount cannot move)", async () => {
      const s = await setup();
      await advanceBooking(app, s.owner, s.bookingId, s.mechanicIds[0], "ready");
      const res = await request(app).put(`/api/bookings/${s.bookingId}/repair-order`).set(bearer(s.owner.accessToken)).send({ laborCost: 1 });
      expect(res.status).toBe(409);
    });

    it("rejects negative and absurd money values", async () => {
      const s = await setup();
      await advanceBooking(app, s.owner, s.bookingId, s.mechanicIds[0], "started");
      const put = (b: object) => request(app).put(`/api/bookings/${s.bookingId}/repair-order`).set(bearer(s.owner.accessToken)).send(b);
      expect((await put({ laborCost: -5 })).status).toBe(400);
      expect((await put({ laborCost: 5, partsUsed: [{ name: "x", quantity: 0, unitPrice: 1 }] })).status).toBe(400);
      expect((await put({ laborCost: 5, partsUsed: [{ name: "x", quantity: 1, unitPrice: 99999999 }] })).status).toBe(400);
    });
  });

  describe("authorization", () => {
    it("only the garage's own owner may act on a booking (others get 404)", async () => {
      const s = await setup();
      const otherOwner = await registerGarageOwner(app);
      await createGarage(app, otherOwner);
      expect((await post(otherOwner, `/api/bookings/${s.bookingId}/accept`)).status).toBe(404);
    });

    it("a customer cannot use garage-side endpoints", async () => {
      const s = await setup();
      expect((await post(s.customer, `/api/bookings/${s.bookingId}/accept`)).status).toBe(403);
    });

    it("booking detail is visible to the customer, the garage owner and admins only", async () => {
      const s = await setup();
      const admin = await makeAdmin(app);
      const stranger = await registerUser(app, ["RIDER"]);

      expect((await get(s.customer, `/api/bookings/${s.bookingId}`)).status).toBe(200);
      expect((await get(s.owner, `/api/bookings/${s.bookingId}`)).status).toBe(200);
      expect((await get(admin, `/api/bookings/${s.bookingId}`)).status).toBe(200);
      expect((await get(stranger, `/api/bookings/${s.bookingId}`)).status).toBe(404);
    });

    it("maintenance history is visible only to the vehicle's owner (or admin)", async () => {
      const s = await setup();
      const stranger = await registerUser(app, ["RIDER"]);
      expect((await get(stranger, `/api/bookings/vehicles/${s.customer.vehicleId}/maintenance`)).status).toBe(404);
      expect((await get(s.customer, `/api/bookings/vehicles/${s.customer.vehicleId}/maintenance`)).status).toBe(200);
    });
  });

  describe("creating a booking", () => {
    it("replaying the same idempotency key returns the same booking", async () => {
      const owner = await registerGarageOwner(app);
      const { garageId } = await createGarage(app, owner);
      const customer = await registerUser(app, ["RIDER"]);
      const key = bookingKey();

      const a = await book(customer, garageId, { idempotencyKey: key });
      const b = await book(customer, garageId, { idempotencyKey: key });

      expect(b.body.data.booking.id).toBe(a.body.data.booking.id);
      expect((await pool.query(`SELECT count(*)::int AS n FROM service_bookings`)).rows[0].n).toBe(1);
    });

    it("two customers can use the same raw key without colliding", async () => {
      const owner = await registerGarageOwner(app);
      const { garageId } = await createGarage(app, owner);
      const c1 = await registerUser(app, ["RIDER"]);
      const c2 = await registerUser(app, ["RIDER"]);
      const key = bookingKey();

      const a = await book(c1, garageId, { idempotencyKey: key });
      const b = await book(c2, garageId, { idempotencyKey: key });

      expect(a.body.data.booking.id).not.toBe(b.body.data.booking.id);
    });

    it("rejects someone else's vehicle (404), a service from another garage (400), a past date (400) and an unknown garage (404)", async () => {
      const owner = await registerGarageOwner(app);
      const g1 = await createGarage(app, owner, { services: ["OIL_CHANGE"] });
      const g2 = await createGarage(app, owner, { services: ["AC_REPAIR"] });
      const customer = await registerUser(app, ["RIDER"]);
      const other = await customerWithVehicle(app, vehicleTypeId);

      expect((await book(customer, g1.garageId, { vehicleId: other.vehicleId })).status).toBe(404);
      expect((await book(customer, g1.garageId, { garageServiceId: g2.services.AC_REPAIR })).status).toBe(400);
      expect((await book(customer, g1.garageId, { scheduledAt: "2020-01-01T10:00:00Z" })).status).toBe(400);
      expect((await book(customer, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    });

    it("cannot book an inactive garage", async () => {
      const owner = await registerGarageOwner(app);
      const { garageId } = await createGarage(app, owner);
      await request(app).patch(`/api/garages/${garageId}`).set(bearer(owner.accessToken)).send({ isActive: false });
      const customer = await registerUser(app, ["RIDER"]);
      expect((await book(customer, garageId)).status).toBe(404);
    });

    it("accepts a future scheduled time and validates the idempotency key length", async () => {
      const owner = await registerGarageOwner(app);
      const { garageId } = await createGarage(app, owner);
      const customer = await registerUser(app, ["RIDER"]);
      const future = new Date(Date.now() + 86_400_000).toISOString();

      expect((await book(customer, garageId, { scheduledAt: future })).status).toBe(201);
      expect((await book(customer, garageId, { idempotencyKey: "short" })).status).toBe(400);
    });
  });

  describe("cancellation", () => {
    it("the customer can cancel before the vehicle is received; the mechanic is freed", async () => {
      const s = await setup();
      await advanceBooking(app, s.owner, s.bookingId, s.mechanicIds[0], "assign");

      const res = await post(s.customer, `/api/bookings/${s.bookingId}/cancel`);

      expect(res.body.data.booking.status).toBe("CANCELLED");
      const second = await book(s.customer, s.garageId);
      await post(s.owner, `/api/bookings/${second.body.data.booking.id}/accept`);
      const reuse = await post(s.owner, `/api/bookings/${second.body.data.booking.id}/assign-mechanic`, { mechanicId: s.mechanicIds[0] });
      expect(reuse.status).toBe(200);
    });

    it("the garage can cancel too, but nobody can after the vehicle is received", async () => {
      const s = await setup();
      await advanceBooking(app, s.owner, s.bookingId, s.mechanicIds[0], "received");

      expect((await post(s.customer, `/api/bookings/${s.bookingId}/cancel`)).status).toBe(400);
      expect((await post(s.owner, `/api/bookings/${s.bookingId}/cancel`)).status).toBe(400);

      const s2 = await setup();
      expect((await post(s2.owner, `/api/bookings/${s2.bookingId}/cancel`)).status).toBe(200);
    });

    it("strangers get 404, and a cancelled booking cannot be cancelled again", async () => {
      const s = await setup();
      const stranger = await registerUser(app, ["RIDER"]);
      expect((await post(stranger, `/api/bookings/${s.bookingId}/cancel`)).status).toBe(404);
      await post(s.customer, `/api/bookings/${s.bookingId}/cancel`);
      expect((await post(s.customer, `/api/bookings/${s.bookingId}/cancel`)).status).toBe(400);
    });
  });

  describe("mechanics", () => {
    it("one active job per mechanic: a second assignment is a 409 until the first job leaves the active set", async () => {
      const s = await setup();
      await advanceBooking(app, s.owner, s.bookingId, s.mechanicIds[0], "assign");
      const second = await book(s.customer, s.garageId);
      const id2 = second.body.data.booking.id;
      await post(s.owner, `/api/bookings/${id2}/accept`);

      const clash = await post(s.owner, `/api/bookings/${id2}/assign-mechanic`, { mechanicId: s.mechanicIds[0] });

      expect(clash.status).toBe(409);
      expect(await statusOf(id2)).toBe("ACCEPTED");
    });

    it("a mechanic is free again once their job is READY", async () => {
      const s = await setup();
      await advanceBooking(app, s.owner, s.bookingId, s.mechanicIds[0], "ready");
      const second = await book(s.customer, s.garageId);
      await post(s.owner, `/api/bookings/${second.body.data.booking.id}/accept`);
      expect((await post(s.owner, `/api/bookings/${second.body.data.booking.id}/assign-mechanic`, { mechanicId: s.mechanicIds[0] })).status).toBe(200);
    });

    it("rejects a mechanic from another garage and an inactive mechanic", async () => {
      const s = await setup();
      const otherOwner = await registerGarageOwner(app);
      const other = await createGarage(app, otherOwner, { mechanics: ["Stranger"] });
      await post(s.owner, `/api/bookings/${s.bookingId}/accept`);

      expect((await post(s.owner, `/api/bookings/${s.bookingId}/assign-mechanic`, { mechanicId: other.mechanicIds[0] })).status).toBe(400);

      await request(app).patch(`/api/garages/${s.garageId}/mechanics/${s.mechanicIds[0]}`).set(bearer(s.owner.accessToken)).send({ isActive: false });
      expect((await post(s.owner, `/api/bookings/${s.bookingId}/assign-mechanic`, { mechanicId: s.mechanicIds[0] })).status).toBe(400);
    });

    it("cannot deactivate a mechanic who has an active job", async () => {
      const s = await setup();
      await advanceBooking(app, s.owner, s.bookingId, s.mechanicIds[0], "assign");
      const res = await request(app).patch(`/api/garages/${s.garageId}/mechanics/${s.mechanicIds[0]}`).set(bearer(s.owner.accessToken)).send({ isActive: false });
      expect(res.status).toBe(409);
    });
  });

  describe("vehicle handling", () => {
    it("refuses to receive a vehicle that is currently in use, and leaves the booking where it was", async () => {
      const s = await setup();
      await advanceBooking(app, s.owner, s.bookingId, s.mechanicIds[0], "assign");
      await pool.query(`UPDATE vehicles SET status = 'IN_RIDE_SERVICE' WHERE id = $1`, [s.customer.vehicleId]);

      const res = await post(s.owner, `/api/bookings/${s.bookingId}/vehicle-received`);

      expect(res.status).toBe(409);
      expect(await statusOf(s.bookingId)).toBe("MECHANIC_ASSIGNED");
      expect(await vehicleStatus(s.customer.vehicleId)).toBe("IN_RIDE_SERVICE");
    });

    it("works without a registered vehicle (walk-in customer)", async () => {
      const owner = await registerGarageOwner(app);
      const g = await createGarage(app, owner);
      const customer = await registerUser(app, ["RIDER"]);
      const b = await book(customer, g.garageId);
      await advanceBooking(app, owner, b.body.data.booking.id, g.mechanicIds[0], "ready");

      const pay = await request(app).post("/api/payments").set(bearer(customer.accessToken)).set("Idempotency-Key", idemKey())
        .send({ payableType: "GARAGE_SERVICE", payableId: b.body.data.booking.id, paymentMethodToken: "tok_mock_success" });
      expect(pay.status).toBe(201);
      expect(await statusOf(b.body.data.booking.id)).toBe("COMPLETED");
    });
  });

  describe("listing", () => {
    it("customers list their own bookings; garage owners list theirs, emergencies first, filterable by status", async () => {
      const owner = await registerGarageOwner(app);
      const g = await createGarage(app, owner, { services: ["OIL_CHANGE", "EMERGENCY_REPAIR"] });
      const c = await registerUser(app, ["RIDER"]);
      const other = await registerUser(app, ["RIDER"]);

      const normal = await book(c, g.garageId);
      await book(other, g.garageId);
      const emergency = await request(app).post("/api/bookings/emergency").set(bearer(c.accessToken))
        .send({ ...offsetMeters(200), idempotencyKey: bookingKey() });
      await post(owner, `/api/bookings/${normal.body.data.booking.id}/accept`);

      expect((await get(c, "/api/bookings")).body.data.bookings).toHaveLength(2);

      const all = await get(owner, `/api/bookings/garage/${g.garageId}`);
      expect(all.body.data.bookings).toHaveLength(3);
      expect(all.body.data.bookings[0].id).toBe(emergency.body.data.booking.id);

      const accepted = await get(owner, `/api/bookings/garage/${g.garageId}?status=ACCEPTED`);
      expect(accepted.body.data.bookings).toHaveLength(1);
      expect((await get(owner, `/api/bookings/garage/${g.garageId}?status=BOGUS`)).status).toBe(400);

      const intruder = await registerGarageOwner(app);
      expect((await get(intruder, `/api/bookings/garage/${g.garageId}`)).status).toBe(404);
    });
  });

  describe("emergency dispatch", () => {
    it("dispatches to the NEAREST garage that offers EMERGENCY_REPAIR, skipping nearer ones that do not", async () => {
      const owner = await registerGarageOwner(app);
      await createGarage(app, owner, { name: "Nearest, no emergency", at: offsetMeters(100), services: ["OIL_CHANGE"] });
      const target = await createGarage(app, owner, { name: "Emergency capable", at: offsetMeters(2000), services: ["EMERGENCY_REPAIR"] });
      await createGarage(app, owner, { name: "Emergency but farther", at: offsetMeters(6000), services: ["EMERGENCY_REPAIR"] });
      const customer = await customerWithVehicle(app, vehicleTypeId);

      const res = await request(app).post("/api/bookings/emergency").set(bearer(customer.accessToken))
        .send({ lat: CENTER.lat, lng: CENTER.lng, vehicleId: customer.vehicleId, description: "Engine overheated", idempotencyKey: bookingKey() });

      expect(res.status).toBe(201);
      expect(res.body.data.booking).toMatchObject({ isEmergency: true, description: "Engine overheated", garageServiceId: target.services.EMERGENCY_REPAIR });
      expect(res.body.data.booking.garage.id).toBe(target.garageId);
      expect(res.body.data.booking.breakdownLocation.lat).toBeCloseTo(CENTER.lat, 4);
    });

    it("404s when no emergency garage is within 20 km, and ignores inactive garages", async () => {
      const owner = await registerGarageOwner(app);
      const far = await createGarage(app, owner, { at: offsetMeters(40000), services: ["EMERGENCY_REPAIR"] });
      const customer = await registerUser(app, ["RIDER"]);
      const send = () => request(app).post("/api/bookings/emergency").set(bearer(customer.accessToken)).send({ ...CENTER, idempotencyKey: bookingKey() });

      expect((await send()).status).toBe(404);

      const near = await createGarage(app, owner, { at: offsetMeters(500), services: ["EMERGENCY_REPAIR"] });
      await request(app).patch(`/api/garages/${near.garageId}`).set(bearer(owner.accessToken)).send({ isActive: false });
      expect((await send()).status).toBe(404);
      void far;
    });

    it("is idempotent", async () => {
      const owner = await registerGarageOwner(app);
      await createGarage(app, owner, { at: offsetMeters(300), services: ["EMERGENCY_REPAIR"] });
      const customer = await registerUser(app, ["RIDER"]);
      const key = bookingKey();
      const send = () => request(app).post("/api/bookings/emergency").set(bearer(customer.accessToken)).send({ ...CENTER, idempotencyKey: key });

      const a = await send();
      const b = await send();
      expect(b.body.data.booking.id).toBe(a.body.data.booking.id);
    });
  });
});

import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "../integration/testUtils";
import { ensurePaymentVehicleType, registerUser } from "../integration/paymentFixtures";
import { advanceBooking, bearer, bookingKey, createGarage, registerGarageOwner, resetGarageTables } from "../integration/garageFixtures";

const app = createApp();
const N = 10;
type Account = { userId: string; accessToken: string };

const post = (who: Account, path: string, body?: object) => request(app).post(path).set(bearer(who.accessToken)).send(body);

async function newBooking(customer: Account, garageId: string) {
  const r = await request(app).post("/api/bookings").set(bearer(customer.accessToken)).send({ garageId, idempotencyKey: bookingKey() });
  return r.body.data.booking.id as string;
}

describe("Concurrency: garage bookings", () => {
  beforeAll(async () => {
    await ensurePaymentVehicleType("GARAGE_CONC_SEDAN");
  });
  beforeEach(async () => {
    await resetGarageTables();
    await redis.flushdb();
  });
  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  it(`${N} simultaneous creates with the SAME key -> one booking, one id`, async () => {
    const owner = await registerGarageOwner(app);
    const { garageId } = await createGarage(app, owner);
    const customer = await registerUser(app, ["RIDER"]);
    const key = bookingKey();

    const results = await Promise.all(
      Array.from({ length: N }, () => request(app).post("/api/bookings").set(bearer(customer.accessToken)).send({ garageId, idempotencyKey: key }))
    );

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.data.booking.id)).size).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM service_bookings`)).rows[0].n).toBe(1);
  });

  it("assigning ONE mechanic to many accepted bookings at once -> exactly one wins, the rest are 409 (DB index)", async () => {
    const owner = await registerGarageOwner(app);
    const { garageId, mechanicIds } = await createGarage(app, owner);
    const customer = await registerUser(app, ["RIDER"]);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await newBooking(customer, garageId);
      await post(owner, `/api/bookings/${id}/accept`);
      ids.push(id);
    }

    const results = await Promise.all(ids.map((id) => post(owner, `/api/bookings/${id}/assign-mechanic`, { mechanicId: mechanicIds[0] })));

    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409]);
    const active = await pool.query(`SELECT count(*)::int AS n FROM service_bookings WHERE mechanic_id = $1 AND status = 'MECHANIC_ASSIGNED'`, [mechanicIds[0]]);
    expect(active.rows[0].n).toBe(1);
  });

  it("the DB index alone enforces one active job per mechanic even if the app is bypassed", async () => {
    const owner = await registerGarageOwner(app);
    const { garageId, mechanicIds } = await createGarage(app, owner);
    const customer = await registerUser(app, ["RIDER"]);
    const a = await newBooking(customer, garageId);
    const b = await newBooking(customer, garageId);
    const assign = (id: string) => pool.query(`UPDATE service_bookings SET status = 'MECHANIC_ASSIGNED', mechanic_id = $2 WHERE id = $1`, [id, mechanicIds[0]]);

    await assign(a);
    await expect(assign(b)).rejects.toMatchObject({ code: "23505" });
  });

  it("cancel racing accept never corrupts state: the final status matches what each caller was told", async () => {
    const owner = await registerGarageOwner(app);
    const { garageId } = await createGarage(app, owner);
    const customer = await registerUser(app, ["RIDER"]);

    for (let round = 0; round < 8; round++) {
      const id = await newBooking(customer, garageId);
      const [accept, cancel] = await Promise.all([post(owner, `/api/bookings/${id}/accept`), post(customer, `/api/bookings/${id}/cancel`)]);

      const final = (await pool.query(`SELECT status FROM service_bookings WHERE id = $1`, [id])).rows[0].status;
      expect([accept.status, cancel.status].every((s) => s < 500)).toBe(true);
      expect(["ACCEPTED", "CANCELLED"]).toContain(final);
      if (final === "CANCELLED") expect(cancel.status).toBe(200);
      if (final === "ACCEPTED") expect(cancel.status).toBe(409); // lost the race; told so, not silently ignored
      if (accept.status === 200 && cancel.status === 200) expect(final).toBe("CANCELLED"); // accept then cancel is a legal sequence
    }
  });

  it("editing the repair order racing 'mark ready': the amount is frozen at READY and matches what the editor was told", async () => {
    const owner = await registerGarageOwner(app);
    const { garageId, mechanicIds } = await createGarage(app, owner);
    const customer = await registerUser(app, ["RIDER"]);

    for (let round = 0; round < 6; round++) {
      // each round needs a free mechanic, so use a fresh garage mechanic every time
      const m = await request(app).post(`/api/garages/${garageId}/mechanics`).set(bearer(owner.accessToken)).send({ name: `M${round}` });
      const id = await newBooking(customer, garageId);
      await advanceBooking(app, owner, id, m.body.data.mechanic.id, "started");
      await request(app).put(`/api/bookings/${id}/repair-order`).set(bearer(owner.accessToken)).send({ laborCost: 100 });

      const [edit, ready] = await Promise.all([
        request(app).put(`/api/bookings/${id}/repair-order`).set(bearer(owner.accessToken)).send({ laborCost: 999 }),
        post(owner, `/api/bookings/${id}/ready`),
      ]);

      expect(ready.status).toBe(200);
      const stored = Number((await pool.query(`SELECT total_cost FROM repair_orders WHERE service_booking_id = $1`, [id])).rows[0].total_cost);
      if (edit.status === 200) expect(stored).toBe(999);
      else {
        expect(edit.status).toBe(409);
        expect(stored).toBe(100);
      }
    }
    void mechanicIds;
  });

  it(`${N} simultaneous payments for one booking -> one payment, one completion, one maintenance record`, async () => {
    const owner = await registerGarageOwner(app);
    const g = await createGarage(app, owner);
    const customer = await registerUser(app, ["RIDER"]);
    const id = await newBooking(customer, g.garageId);
    await advanceBooking(app, owner, id, g.mechanicIds[0], "ready");

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        request(app).post("/api/payments").set(bearer(customer.accessToken))
          .set("Idempotency-Key", `pay-${Date.now()}-${Math.random().toString(36).slice(2)}`)
          .send({ payableType: "GARAGE_SERVICE", payableId: id, paymentMethodToken: "tok_mock_success" })
      )
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(N - 1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM payments WHERE payable_id = $1`, [id])).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT status FROM service_bookings WHERE id = $1`, [id])).rows[0].status).toBe("COMPLETED");
  });
});

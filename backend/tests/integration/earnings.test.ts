import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";
import { createCompletedRide, ensurePaymentVehicleType, idemKey, makeAdmin, registerUser } from "./paymentFixtures";
import {
  bearer, confirmedBooking, createRentalListing, ensureRentalVehicleType, moveWindow, registerOwner, registerRenter,
} from "./rentalFixtures";
import { earningsService } from "../../src/modules/earnings/services/earnings.service";
import { earningsRepository } from "../../src/modules/earnings/repositories/earnings.repository";
import { MockPayoutProvider, setPayoutProviderForTests } from "../../src/modules/earnings/services/PayoutProvider";
import { getPaymentProvider } from "../../src/modules/payments/services/providers";
import { splitRideFare, toPaise } from "../../src/modules/earnings/services/earningsSplit";

const app = createApp();
let vt: string;
let rentVt: string;
let admin: { userId: string; accessToken: string };
let payout: MockPayoutProvider;

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const sum = async (sql: string, params: unknown[] = []) => Number((await q(sql, params))[0].s ?? 0);

async function reset() {
  await pool.query(`TRUNCATE platform_commissions, users RESTART IDENTITY CASCADE`);
  await redis.flushdb();
  admin = await makeAdmin(app);
}

/** A ride that is completed AND paid: ledger rows are written as part of the payment. */
async function paidRide() {
  const { rideId, rider, driver } = await createCompletedRide(app, vt, admin);
  const res = await request(app).post("/api/payments").set(bearer(rider.accessToken)).set("Idempotency-Key", idemKey())
    .send({ payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });
  if (res.status !== 201) throw new Error(`pay failed ${res.status} ${JSON.stringify(res.body)}`);
  const fare = Number((await q(`SELECT total_fare FROM ride_fares WHERE ride_id = $1`, [rideId]))[0].total_fare);
  const asg = (await q(`SELECT owner_id, vehicle_id FROM vehicle_driver_assignments WHERE driver_id = $1`, [driver.userId]))[0];
  return { rideId, rider, driver, fare, ownerId: asg.owner_id as string, vehicleId: asg.vehicle_id as string };
}

const get = (t: { accessToken: string }, path: string) => request(app).get(`/api/earnings${path}`).set(bearer(t.accessToken));
const withdraw = (t: { accessToken: string }, body: object = {}, key = idemKey()) =>
  request(app).post("/api/earnings/payouts").set(bearer(t.accessToken)).set("Idempotency-Key", key).send(body);

/** Gives a user spendable balance without going through a ride. */
const grant = (userId: string, amount: number) =>
  pool.query(`INSERT INTO driver_earnings (driver_id, type, amount) VALUES ($1, 'BONUS', $2)`, [userId, amount]);

describe("Phase 17: earnings split, dashboards, payouts (live DB + Redis)", () => {
  beforeAll(async () => {
    vt = await ensurePaymentVehicleType("EARN_TEST");
    rentVt = await ensureRentalVehicleType("EARN_RENT", "BOTH");
  });
  beforeEach(async () => {
    await reset();
    payout = new MockPayoutProvider();
    setPayoutProviderForTests(payout);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { setPayoutProviderForTests(null); await closeTestDb(); redis.disconnect(); });

  describe("ride settlement", () => {
    it("paying a ride splits the fare: platform 20%, owner 80% of the rest, driver the remainder", async () => {
      const r = await paidRide();
      const expected = splitRideFare(toPaise(r.fare), 20, 80);

      const [commission] = await q(`SELECT * FROM platform_commissions WHERE source_type = 'RIDE' AND source_id = $1`, [r.rideId]);
      const [owner] = await q(`SELECT * FROM owner_earnings WHERE source_id = $1`, [r.rideId]);
      const [driver] = await q(`SELECT * FROM driver_earnings WHERE ride_id = $1`, [r.rideId]);

      expect(Math.round(Number(commission.amount) * 100)).toBe(expected.platform);
      expect(Number(commission.rate_percent)).toBe(20);
      expect(Math.round(Number(owner.amount) * 100)).toBe(expected.owner);
      expect(owner).toMatchObject({ owner_id: r.ownerId, source_type: "RIDE_SHARE", vehicle_id: r.vehicleId, driver_id: r.driver.userId });
      expect(Math.round(Number(driver.amount) * 100)).toBe(expected.driver);
      expect(driver).toMatchObject({ driver_id: r.driver.userId, type: "RIDE_FARE" });
      // the three parts add back up to what the rider paid, to the paisa
      expect(expected.platform + expected.owner + expected.driver).toBe(toPaise(r.fare));
    });

    it("is idempotent: replaying the payment and re-running settlement never duplicates the ledger", async () => {
      const r = await paidRide();
      await earningsService.settleRide(r.rideId);
      await earningsService.settleRide(r.rideId);
      expect(await sum(`SELECT COUNT(*) AS s FROM platform_commissions WHERE source_id = $1`, [r.rideId])).toBe(1);
      expect(await sum(`SELECT COUNT(*) AS s FROM owner_earnings WHERE source_id = $1`, [r.rideId])).toBe(1);
      expect(await sum(`SELECT COUNT(*) AS s FROM driver_earnings WHERE ride_id = $1`, [r.rideId])).toBe(1);
    });

    it("CONCURRENCY: 8 simultaneous settlements of one ride write exactly one set of rows", async () => {
      const { rideId, rider, driver } = await createCompletedRide(app, vt, admin);
      // Pay without the automatic settlement, so the race is purely between our 8 calls.
      jest.spyOn(earningsRepository, "settleRide").mockRejectedValueOnce(new Error("boom"));
      const res = await request(app).post("/api/payments").set(bearer(rider.accessToken)).set("Idempotency-Key", idemKey())
        .send({ payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });
      expect(res.status).toBe(201);
      expect(await sum(`SELECT COUNT(*) AS s FROM driver_earnings WHERE ride_id = $1`, [rideId])).toBe(0);

      const results = await Promise.all(Array.from({ length: 8 }, () => earningsService.settleRide(rideId)));
      expect(results.filter((r) => r.settled)).toHaveLength(1);
      expect(await sum(`SELECT COUNT(*) AS s FROM platform_commissions WHERE source_id = $1`, [rideId])).toBe(1);
      expect(await sum(`SELECT COUNT(*) AS s FROM driver_earnings WHERE ride_id = $1`, [rideId])).toBe(1);
      expect(await sum(`SELECT COUNT(*) AS s FROM owner_earnings WHERE source_id = $1`, [rideId])).toBe(1);
      expect(driver.userId).toBeTruthy();
    });

    it("an unpaid ride is never settled", async () => {
      const { rideId } = await createCompletedRide(app, vt, admin);
      const r = await earningsService.settleRide(rideId);
      expect(r.settled).toBe(false);
      expect(await sum(`SELECT COUNT(*) AS s FROM driver_earnings`)).toBe(0);
    });

    it("an agreement that ended after the ride was accepted still applies", async () => {
      const { rideId, rider, driver } = await createCompletedRide(app, vt, admin);
      await pool.query(`UPDATE vehicle_driver_assignments SET status = 'ENDED', ended_at = now() WHERE driver_id = $1`, [driver.userId]);
      await request(app).post("/api/payments").set(bearer(rider.accessToken)).set("Idempotency-Key", idemKey())
        .send({ payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });
      expect(await sum(`SELECT COUNT(*) AS s FROM owner_earnings WHERE source_id = $1`, [rideId])).toBe(1);
    });

    it("with no owner agreement the default platform rate applies and the driver keeps the rest", async () => {
      const { rideId, rider, driver } = await createCompletedRide(app, vt, admin);
      // Pretend the agreement did not cover the moment the ride was accepted.
      await pool.query(`UPDATE vehicle_driver_assignments SET started_at = now() + interval '1 day' WHERE driver_id = $1`, [driver.userId]);
      await request(app).post("/api/payments").set(bearer(rider.accessToken)).set("Idempotency-Key", idemKey())
        .send({ payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });
      const fare = Number((await q(`SELECT total_fare FROM ride_fares WHERE ride_id = $1`, [rideId]))[0].total_fare);
      const expected = splitRideFare(toPaise(fare), 20, null);
      expect(await sum(`SELECT COUNT(*) AS s FROM owner_earnings`)).toBe(0);
      expect(Math.round((await sum(`SELECT amount AS s FROM driver_earnings WHERE ride_id = $1`, [rideId])) * 100)).toBe(expected.driver);
    });

    it("a settlement failure does not fail the payment, and reconcile repairs it exactly once", async () => {
      const { rideId, rider } = await createCompletedRide(app, vt, admin);
      jest.spyOn(earningsRepository, "settleRide").mockRejectedValueOnce(new Error("db hiccup"));
      const pay = await request(app).post("/api/payments").set(bearer(rider.accessToken)).set("Idempotency-Key", idemKey())
        .send({ payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });
      expect(pay.status).toBe(201); // money moved: the rider is not told it failed
      expect(await sum(`SELECT COUNT(*) AS s FROM driver_earnings`)).toBe(0);

      const first = await request(app).post("/api/earnings/reconcile").set(bearer(admin.accessToken)).send({});
      expect(first.status).toBe(200);
      expect(first.body.data.reconciled).toMatchObject({ rides: 1, errors: 0 });
      expect(await sum(`SELECT COUNT(*) AS s FROM driver_earnings WHERE ride_id = $1`, [rideId])).toBe(1);

      const second = await request(app).post("/api/earnings/reconcile").set(bearer(admin.accessToken)).send({});
      expect(second.body.data.reconciled).toMatchObject({ rides: 0 });
    });

    it("the database itself refuses a second fare row for a ride and negative amounts", async () => {
      const r = await paidRide();
      await expect(pool.query(`INSERT INTO driver_earnings (driver_id, ride_id, type, amount) VALUES ($1, $2, 'RIDE_FARE', 1)`, [r.driver.userId, r.rideId])).rejects.toMatchObject({ code: "23505" });
      await expect(pool.query(`INSERT INTO driver_earnings (driver_id, type, amount) VALUES ($1, 'BONUS', -1)`, [r.driver.userId])).rejects.toMatchObject({ code: "23514" });
      await expect(pool.query(`INSERT INTO owner_earnings (owner_id, source_type, source_id, amount) VALUES ($1, 'RENTAL', gen_random_uuid(), -5)`, [r.ownerId])).rejects.toMatchObject({ code: "23514" });
      // but a clawback ADJUSTMENT may be negative
      await expect(pool.query(`INSERT INTO driver_earnings (driver_id, type, amount) VALUES ($1, 'ADJUSTMENT', -5)`, [r.driver.userId])).resolves.toBeDefined();
    });
  });

  describe("rental settlement and deposit refund", () => {
    async function returnedRental(opts: { lateMinutes?: [number, number]; damage?: number } = {}) {
      const owner = await registerOwner(app);
      const renter = await registerRenter(app);
      const listing = await createRentalListing(app, owner, rentVt); // 100/h, deposit 2000
      const b = await confirmedBooking(app, renter, listing.id); // 5h => rent 500
      await moveWindow(b.id, -10, 290);
      const s = await request(app).post(`/api/rentals/bookings/${b.id}/start`).set(bearer(owner.accessToken)).send({});
      expect(s.status).toBe(200);
      if (opts.lateMinutes) await moveWindow(b.id, opts.lateMinutes[0], opts.lateMinutes[1]);
      const done = await request(app).post(`/api/rentals/bookings/${b.id}/complete`).set(bearer(owner.accessToken))
        .send(opts.damage ? { damageDeduction: opts.damage } : {});
      expect(done.status).toBe(200);
      return { owner, renter, b, done: done.body.data.booking };
    }

    it("on-time return: owner earns rent minus 10%, platform keeps 10%, deposit is refunded in full", async () => {
      const { owner, renter, b } = await returnedRental();
      expect(await sum(`SELECT amount AS s FROM owner_earnings WHERE source_id = $1 AND source_type = 'RENTAL'`, [b.id])).toBe(450);
      expect(await sum(`SELECT amount AS s FROM platform_commissions WHERE source_id = $1`, [b.id])).toBe(50);
      expect((await q(`SELECT owner_id FROM owner_earnings WHERE source_id = $1`, [b.id]))[0].owner_id).toBe(owner.userId);

      const [p] = await q(`SELECT * FROM payouts WHERE source_id = $1`, [b.id]);
      expect(p).toMatchObject({ kind: "DEPOSIT_REFUND", status: "PAID", user_id: renter.userId });
      expect(Number(p.amount)).toBe(2000);
      expect(p.provider_reference).toBeTruthy();
    });

    it("late fee and damage: commission only on rent + late fee; damage goes to the owner; refund is what is left", async () => {
      const { b } = await returnedRental({ lateMinutes: [-600, -150], damage: 500 }); // 3 billed hours x 100 x 1.5 = 450
      // chargeable 500 + 450 = 950 -> platform 95 -> owner 855 + 500 damage
      expect(await sum(`SELECT amount AS s FROM platform_commissions WHERE source_id = $1`, [b.id])).toBe(95);
      expect(await sum(`SELECT amount AS s FROM owner_earnings WHERE source_id = $1`, [b.id])).toBe(1355);
      expect(Number((await q(`SELECT amount FROM payouts WHERE source_id = $1`, [b.id]))[0].amount)).toBe(1050);
    });

    it("a deposit fully consumed by deductions creates no refund payout", async () => {
      const { b } = await returnedRental({ lateMinutes: [-2500, -1790] }); // late fee 4500 > deposit
      expect(await sum(`SELECT COUNT(*) AS s FROM payouts WHERE source_id = $1`, [b.id])).toBe(0);
    });

    it("the refund moves money once and is idempotent", async () => {
      const { b } = await returnedRental();
      const spy = jest.spyOn(getPaymentProvider(), "refund");
      expect(await (await import("../../src/modules/earnings/services/payouts.service")).payoutsService.refundDeposit(b.id)).toBe(false);
      await earningsService.settleRental(b.id);
      expect(spy).not.toHaveBeenCalled();
      expect(await sum(`SELECT COUNT(*) AS s FROM payouts WHERE source_id = $1`, [b.id])).toBe(1);
      expect(await sum(`SELECT COUNT(*) AS s FROM owner_earnings WHERE source_id = $1`, [b.id])).toBe(1);
    });

    it("a refund provider outage does not fail the return; reconcile pays it later, once", async () => {
      jest.spyOn(getPaymentProvider(), "refund").mockRejectedValueOnce(new Error("gateway down"));
      const { b } = await returnedRental();
      expect((await q(`SELECT status FROM payouts WHERE source_id = $1`, [b.id]))[0].status).toBe("PENDING");
      expect(await sum(`SELECT amount AS s FROM owner_earnings WHERE source_id = $1`, [b.id])).toBe(450); // owner is still paid

      const r = await request(app).post("/api/earnings/reconcile").set(bearer(admin.accessToken)).send({});
      expect(r.body.data.reconciled.depositRefunds).toBe(1);
      expect((await q(`SELECT status FROM payouts WHERE source_id = $1`, [b.id]))[0].status).toBe("PAID");

      const again = await request(app).post("/api/earnings/reconcile").set(bearer(admin.accessToken)).send({});
      expect(again.body.data.reconciled.depositRefunds).toBe(0);
    });

    it("the database allows only one deposit refund per booking", async () => {
      const { b, renter } = await returnedRental();
      await expect(pool.query(
        `INSERT INTO payouts (user_id, kind, amount, source_type, source_id, idempotency_key) VALUES ($1, 'DEPOSIT_REFUND', 1, 'RENTAL', $2, 'another-key')`,
        [renter.userId, b.id]
      )).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("dashboards", () => {
    it("owner: ride share + rental revenue - maintenance = net, with a per-vehicle breakdown", async () => {
      const r = await paidRide();
      const ownerAcct = { accessToken: await tokenFor(r.ownerId) };
      await pool.query(`INSERT INTO maintenance_records (vehicle_id, cost, notes) VALUES ($1, 30.50, 'tyres')`, [r.vehicleId]);

      const res = await get(ownerAcct, "/owner/summary");
      expect(res.status).toBe(200);
      const d = res.body.data;
      const share = splitRideFare(toPaise(r.fare), 20, 80).owner / 100;
      expect(d.rideShareEarnings).toBe(share);
      expect(d.rentalRevenue).toBe(0);
      expect(d.maintenanceCost).toBe(30.5);
      expect(d.netEarnings).toBe(Math.round((share - 30.5) * 100) / 100);
      expect(d.rideCount).toBe(1);
      expect(d.vehicles).toHaveLength(1);
      expect(d.vehicles[0]).toMatchObject({ vehicleId: r.vehicleId, rideShareEarnings: share, maintenanceCost: 30.5 });
      expect(d.balance.earned).toBe(share);
    });

    it("driver: fares, bonuses and the withdrawable balance", async () => {
      const r = await paidRide();
      await grant(r.driver.userId, 25);
      const d = (await get(r.driver, "/driver/summary")).body.data;
      const fare = splitRideFare(toPaise(r.fare), 20, 80).driver / 100;
      expect(d).toMatchObject({ rideFares: fare, bonuses: 25, rideCount: 1 });
      expect(d.totalEarnings).toBe(Math.round((fare + 25) * 100) / 100);
      expect(d.balance.available).toBe(d.totalEarnings);
    });

    it("date range filters the totals ([from, to))", async () => {
      const r = await paidRide();
      const future = new Date(Date.now() + 86_400_000).toISOString();
      expect((await get(r.driver, `/driver/summary?from=${future}`)).body.data.rideCount).toBe(0);
      const past = new Date(Date.now() - 86_400_000).toISOString();
      expect((await get(r.driver, `/driver/summary?from=${past}&to=${future}`)).body.data.rideCount).toBe(1);
      expect((await get(r.driver, `/driver/summary?from=${future}&to=${past}`)).status).toBe(400);
    });

    it("platform commission is admin-only and sums every source", async () => {
      const r = await paidRide();
      expect((await get(r.driver, "/platform")).status).toBe(403);
      const res = await get(admin, "/platform");
      expect(res.status).toBe(200);
      expect(res.body.data.totalCommission).toBe(splitRideFare(toPaise(r.fare), 20, 80).platform / 100);
      expect(res.body.data.bySource).toEqual([{ sourceType: "RIDE", amount: res.body.data.totalCommission, count: 1 }]);
    });

    it("role gates: a driver cannot read the owner dashboard and vice versa; anonymous is 401", async () => {
      const r = await paidRide();
      expect((await get(r.driver, "/owner/summary")).status).toBe(403);
      const owner = { accessToken: await tokenFor(r.ownerId) };
      expect((await get(owner, "/driver/summary")).status).toBe(403);
      expect((await request(app).get("/api/earnings/balance")).status).toBe(401);
    });

    it("an owner sees only their own earnings", async () => {
      await paidRide();
      const other = await registerUser(app, ["VEHICLE_OWNER"]);
      const d = (await get(other, "/owner/summary")).body.data;
      expect(d).toMatchObject({ grossEarnings: 0, rideCount: 0 });
      expect(d.vehicles).toEqual([]);
    });

    it("the ledger is keyset-paginated: no duplicates, no gaps, opaque cursor", async () => {
      const u = await registerUser(app, ["DRIVER"]);
      for (let i = 1; i <= 5; i++) await grant(u.userId, i);
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 5; guard++) {
        const res: request.Response = await get(u, `/driver/entries?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
        expect(res.status).toBe(200);
        seen.push(...res.body.data.entries.map((e: { amount: number }) => e.amount));
        cursor = res.body.data.nextCursor;
        if (!cursor) break;
      }
      expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
      expect((await get(u, "/driver/entries?cursor=garbage")).status).toBe(400);
    });
  });

  describe("withdrawals", () => {
    it("withdraws the whole balance by default, and the balance drops to zero", async () => {
      const u = await registerUser(app, ["DRIVER"]);
      await grant(u.userId, 750);
      const res = await withdraw(u);
      expect(res.status).toBe(201);
      expect(res.body.data.payout).toMatchObject({ kind: "EARNINGS_WITHDRAWAL", amount: 750, status: "PAID" });
      expect((await get(u, "/balance")).body.data.balance).toEqual({ earned: 750, withdrawn: 750, available: 0 });
      expect((await get(u, "/payouts")).body.data.payouts).toHaveLength(1);
    });

    it("a partial withdrawal leaves the rest available", async () => {
      const u = await registerUser(app, ["DRIVER"]);
      await grant(u.userId, 1000);
      await withdraw(u, { amount: 300.25 });
      expect((await get(u, "/balance")).body.data.balance.available).toBe(699.75);
    });

    it("is idempotent: the same key returns the same payout and the provider is called once", async () => {
      const u = await registerUser(app, ["DRIVER"]);
      await grant(u.userId, 500);
      const key = idemKey();
      const a = await withdraw(u, {}, key);
      const b = await withdraw(u, {}, key);
      expect(a.status).toBe(201);
      expect(b.body.data.payout.id).toBe(a.body.data.payout.id);
      expect(payout.calls).toBe(1);
      expect(await sum(`SELECT COUNT(*) AS s FROM payouts`)).toBe(1);
    });

    it("the same key with a different amount is refused", async () => {
      const u = await registerUser(app, ["DRIVER"]);
      await grant(u.userId, 500);
      const key = idemKey();
      await withdraw(u, { amount: 200 }, key);
      expect((await withdraw(u, { amount: 300 }, key)).status).toBe(409);
    });

    it("keys are namespaced per user: two users may send the same key", async () => {
      const a = await registerUser(app, ["DRIVER"]);
      const b = await registerUser(app, ["DRIVER"]);
      await grant(a.userId, 500); await grant(b.userId, 500);
      const key = idemKey();
      expect((await withdraw(a, {}, key)).status).toBe(201);
      const rb = await withdraw(b, {}, key);
      expect(rb.status).toBe(201);
      expect(payout.calls).toBe(2);
    });

    it("validation: needs the header, a positive amount, and respects the minimum and the balance", async () => {
      const u = await registerUser(app, ["DRIVER"]);
      expect((await request(app).post("/api/earnings/payouts").set(bearer(u.accessToken)).send({})).status).toBe(400);
      expect((await withdraw(u, {})).status).toBe(409); // nothing to withdraw
      await grant(u.userId, 150);
      expect((await withdraw(u, { amount: 0 })).status).toBe(400);
      expect((await withdraw(u, { amount: -5 })).status).toBe(400);
      expect((await withdraw(u, { amount: 10.123 })).status).toBe(400);
      expect((await withdraw(u, { amount: 50 })).status).toBe(400); // below MIN_PAYOUT_AMOUNT (100)
      expect((await withdraw(u, { amount: 151 })).status).toBe(409); // more than available
      expect((await withdraw(u, { amount: 150, userId: "x" })).status).toBe(400); // strict schema
      expect((await withdraw(u, { amount: 150 })).status).toBe(201);
    });

    it("a rejected transfer is FAILED and the money returns to the balance", async () => {
      const u = await registerUser(app, ["DRIVER"]);
      await grant(u.userId, 400);
      payout.mode = "decline";
      const res = await withdraw(u);
      expect(res.body.data.payout).toMatchObject({ status: "FAILED", failureReason: "bank_account_rejected" });
      expect((await get(u, "/balance")).body.data.balance.available).toBe(400);
      payout.mode = "ok";
      expect((await withdraw(u)).status).toBe(201); // can try again with a new key
    });

    it("an unknown provider outcome keeps the money reserved (PENDING); a retry with the same key finishes it", async () => {
      const u = await registerUser(app, ["DRIVER"]);
      await grant(u.userId, 400);
      const key = idemKey();
      payout.mode = "error";
      expect((await withdraw(u, {}, key)).status).toBe(502);
      expect((await get(u, "/balance")).body.data.balance.available).toBe(0); // reserved: cannot be withdrawn twice
      expect((await withdraw(u, {})).status).toBe(409);

      payout.mode = "ok";
      const retry = await withdraw(u, {}, key);
      expect(retry.status).toBe(201);
      expect(retry.body.data.payout.status).toBe("PAID");
      expect(await sum(`SELECT COUNT(*) AS s FROM payouts`)).toBe(1);
    });

    it("CONCURRENCY: 6 simultaneous withdrawals of 400 from a balance of 1000 succeed exactly twice", async () => {
      const u = await registerUser(app, ["DRIVER"]);
      await grant(u.userId, 1000);
      const res = await Promise.all(Array.from({ length: 6 }, () => withdraw(u, { amount: 400 })));
      expect(res.filter((r) => r.status === 201)).toHaveLength(2);
      expect(res.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await sum(`SELECT COALESCE(SUM(amount),0) AS s FROM payouts WHERE status <> 'FAILED'`)).toBe(800);
      expect((await get(u, "/balance")).body.data.balance.available).toBe(200);
      expect(payout.calls).toBe(2);
    });

    it("CONCURRENCY: the same key sent 6 times at once pays once", async () => {
      const u = await registerUser(app, ["DRIVER"]);
      await grant(u.userId, 1000);
      const key = idemKey();
      const res = await Promise.all(Array.from({ length: 6 }, () => withdraw(u, {}, key)));
      expect(res.every((r) => r.status === 201)).toBe(true);
      expect(new Set(res.map((r) => r.body.data.payout.id)).size).toBe(1);
      expect(payout.calls).toBe(1);
    });

    it("a user's withdrawal can never touch someone else's balance", async () => {
      const rich = await registerUser(app, ["DRIVER"]);
      const poor = await registerUser(app, ["DRIVER"]);
      await grant(rich.userId, 5000);
      expect((await withdraw(poor, { amount: 200 })).status).toBe(409);
    });
  });

  // Signs a user in again with the shared test password, to act as `userId`.
  async function tokenFor(userId: string): Promise<string> {
    const email = (await q(`SELECT email FROM users WHERE id = $1`, [userId]))[0].email;
    const login = await request(app).post("/api/auth/login").send({ email, password: "Passw0rd123" });
    return login.body.data.accessToken;
  }
});

import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";
import { createCompletedRide, ensurePaymentVehicleType, idemKey, makeAdmin, registerUser } from "./paymentFixtures";
import { bearer } from "./garageFixtures";
import { MockPayoutProvider, setPayoutProviderForTests } from "../../src/modules/earnings/services/PayoutProvider";
import { splitRideFare, toPaise } from "../../src/modules/earnings/services/earningsSplit";
import { analyticsRepository } from "../../src/modules/analytics/repositories/analytics.repository";

const app = createApp();
let vt: string;
let admin: { userId: string; accessToken: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const get = (path: string, t = admin) => request(app).get(path).set(bearer(t.accessToken));

async function paidRide() {
  const r = await createCompletedRide(app, vt, admin);
  const res = await request(app).post("/api/payments").set(bearer(r.rider.accessToken)).set("Idempotency-Key", idemKey())
    .send({ payableType: "RIDE", payableId: r.rideId, paymentMethodToken: "tok_mock_success" });
  if (res.status !== 201) throw new Error(`pay failed ${res.status}`);
  const fare = Number((await q(`SELECT total_fare FROM ride_fares WHERE ride_id = $1`, [r.rideId]))[0].total_fare);
  return { ...r, fare, paymentId: res.body.data.payment.id as string };
}

describe("Phase 18: analytics, revenue and system health (live DB + Redis)", () => {
  beforeAll(async () => { vt = await ensurePaymentVehicleType("ANALYTICS_TEST"); });
  beforeEach(async () => {
    await pool.query(`TRUNCATE platform_commissions, users RESTART IDENTITY CASCADE`);
    await redis.flushdb();
    admin = await makeAdmin(app);
    setPayoutProviderForTests(new MockPayoutProvider());
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { setPayoutProviderForTests(null); await sleep(300); await closeTestDb(); redis.disconnect(); });

  describe("overview", () => {
    it("counts users, drivers, vehicles, rides and payments, with correct rates", async () => {
      const a = await paidRide();
      const b = await createCompletedRide(app, vt, admin); // completed, unpaid
      // a third ride cancelled by the rider
      const rider = await registerUser(app, ["RIDER"]);
      const rr = await request(app).post("/api/rides/request").set(bearer(rider.accessToken)).send({
        pickup: { lat: 12.9716, lng: 77.5946, address: "A" }, dropoff: { lat: 12.935, lng: 77.6245, address: "B" }, vehicleTypeId: vt, idempotencyKey: idemKey(),
      });
      await request(app).post(`/api/rides/${rr.body.data.ride.id}/cancel`).set(bearer(rider.accessToken)).send({});

      const res = await get("/api/analytics/overview");
      expect(res.status).toBe(200);
      const d = res.body.data;

      expect(d.rides.total).toBe(3);
      expect(d.rides.byStatus).toMatchObject({ PAYMENT_COMPLETED: 1, TRIP_COMPLETED: 1, CANCELLED_BY_RIDER: 1 });
      expect(d.rides.completed).toBe(2);
      expect(d.rides.cancelled).toBe(1);
      expect(d.rides.completionRate).toBe(0.667);
      expect(d.rides.cancellationRate).toBe(0.333);
      expect(d.rides.avgFare).toBeCloseTo((a.fare + Number((await q(`SELECT total_fare FROM ride_fares WHERE ride_id = $1`, [b.rideId]))[0].total_fare)) / 2, 1);
      expect(d.rides.activeNow).toBe(0);

      expect(d.drivers).toMatchObject({ total: 2, byVerification: { VERIFIED: 2 } });
      expect(d.vehicles.total).toBe(2);
      expect(d.users.byRole.ADMIN).toBe(1);
      expect(d.users.byRole.DRIVER).toBe(2);
      expect(d.users.total).toBeGreaterThanOrEqual(6);
      expect(d.payments.byStatus.SUCCESS).toEqual({ count: 1, amount: a.fare });
      expect(d.payments.byType).toEqual([{ type: "RIDE", count: 1, amount: a.fare }]);
    });

    it("activeNow counts rides that are in progress", async () => {
      const driver = await createCompletedRide(app, vt, admin);
      const rider = await registerUser(app, ["RIDER"]);
      await request(app).post("/api/rides/request").set(bearer(rider.accessToken)).send({
        pickup: { lat: 12.9716, lng: 77.5946, address: "A" }, dropoff: { lat: 12.935, lng: 77.6245, address: "B" }, vehicleTypeId: vt, idempotencyKey: idemKey(),
      });
      expect(driver.rideId).toBeTruthy();
      expect((await get("/api/analytics/overview")).body.data.rides.activeNow).toBeGreaterThanOrEqual(1);
    });

    it("the date range filters ride counts, and validates its bounds", async () => {
      await paidRide();
      const future = new Date(Date.now() + 86_400_000).toISOString();
      expect((await get(`/api/analytics/overview?from=${future}`)).status).toBe(400); // from after the default end (now)
      const past = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
      expect((await get(`/api/analytics/overview?from=${past}&to=${old}`)).body.data.rides.total).toBe(0);
      expect((await get(`/api/analytics/overview?from=${old}&to=${past}`)).status).toBe(400);
      expect((await get(`/api/analytics/overview?bogus=1`)).status).toBe(400);
    });

    it("an empty platform returns zeros and nulls, not errors", async () => {
      const d = (await get("/api/analytics/overview")).body.data;
      expect(d.rides).toMatchObject({ total: 0, completionRate: 0, cancellationRate: 0, avgFare: null, avgSecondsToAccept: null });
    });
  });

  describe("time series", () => {
    it("is zero-filled: every day in the range appears, empty days read 0", async () => {
      await paidRide();
      const to = new Date();
      const from = new Date(to.getTime() - 3 * 86_400_000);
      const res = await get(`/api/analytics/timeseries?metric=rides&bucket=day&from=${from.toISOString()}&to=${to.toISOString()}`);
      expect(res.status).toBe(200);
      const pts = res.body.data.points as { bucket: string; value: number }[];
      expect(pts.length).toBeGreaterThanOrEqual(3);
      expect(pts.reduce((a, p) => a + p.value, 0)).toBe(1);
      expect(pts.filter((p) => p.value === 0).length).toBe(pts.length - 1);
      expect(pts.map((p) => p.bucket)).toEqual([...pts.map((p) => p.bucket)].sort()); // ordered
    });

    it("supports every metric; gmv and commission match the ledger", async () => {
      const a = await paidRide();
      const total = async (metric: string) => ((await get(`/api/analytics/timeseries?metric=${metric}`)).body.data.points as any[]).reduce((s, p) => s + p.value, 0);
      expect(await total("rides")).toBe(1);
      expect(await total("completed_rides")).toBe(1);
      expect(await total("signups")).toBeGreaterThanOrEqual(4);
      expect(await total("gmv")).toBe(a.fare);
      expect(await total("commission")).toBe(splitRideFare(toPaise(a.fare), 20, 80).platform / 100);
    });

    it("rejects an unknown metric/bucket and a request that would need more than 500 buckets", async () => {
      expect((await get("/api/analytics/timeseries?metric=drop_table")).status).toBe(400);
      expect((await get("/api/analytics/timeseries?metric=rides&bucket=minute")).status).toBe(400);
      expect((await get("/api/analytics/timeseries")).status).toBe(400);
      const from = new Date(Date.now() - 100 * 86_400_000).toISOString();
      expect((await get(`/api/analytics/timeseries?metric=rides&bucket=hour&from=${from}`)).status).toBe(400);
      expect((await get(`/api/analytics/timeseries?metric=rides&bucket=week&from=${from}`)).status).toBe(200);
    });
  });

  describe("revenue", () => {
    it("separates what was collected, what the platform kept, and what it still owes users", async () => {
      const a = await paidRide();
      const s = splitRideFare(toPaise(a.fare), 20, 80);
      const res = await get("/api/analytics/revenue");
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.collected).toMatchObject({ gross: a.fare, refunded: 0 });
      expect(d.collected.byType).toEqual([{ type: "RIDE", gross: a.fare, refunded: 0, net: a.fare }]);
      expect(d.commission.total).toBe(s.platform / 100);
      expect(d.commission.bySource).toEqual([{ source: "RIDE", amount: s.platform / 100, count: 1 }]);
      // owner + driver shares are what the platform owes users until they withdraw
      expect(d.owedToUsers).toBeCloseTo((s.owner + s.driver) / 100, 2);
      // commission + owed == collected: every rupee is accounted for
      expect(d.commission.total + d.owedToUsers).toBeCloseTo(a.fare, 2);
    });

    it("a withdrawal reduces what is owed, and a refund shows as refunded", async () => {
      const a = await paidRide();
      await pool.query(`INSERT INTO driver_earnings (driver_id, type, amount) VALUES ($1, 'BONUS', 500)`, [a.driver.userId]); // lift the driver above the minimum payout
      const wd = await request(app).post("/api/earnings/payouts").set(bearer(a.driver.accessToken)).set("Idempotency-Key", idemKey()).send({});
      expect(wd.status).toBe(201);
      const withdrawn = wd.body.data.payout.amount;
      const before = splitRideFare(toPaise(a.fare), 20, 80);
      const d = (await get("/api/analytics/revenue")).body.data;
      expect(d.owedToUsers).toBeCloseTo((before.owner + before.driver) / 100 + 500 - withdrawn, 2);
      expect(d.payouts).toEqual([{ kind: "EARNINGS_WITHDRAWAL", status: "PAID", amount: withdrawn }]);

      await request(app).post(`/api/payments/${a.paymentId}/refund`).set(bearer(admin.accessToken));
      const after = (await get("/api/analytics/revenue")).body.data;
      expect(after.collected).toMatchObject({ gross: 0, refunded: a.fare });
    });
  });

  describe("leaderboards", () => {
    it("ranks drivers and owners by earnings", async () => {
      const a = await paidRide();
      const b = await paidRide();
      await pool.query(`INSERT INTO driver_earnings (driver_id, type, amount) VALUES ($1, 'BONUS', 1000)`, [b.driver.userId]);
      const d = (await get("/api/analytics/leaderboards?limit=5")).body.data;
      expect(d.topDrivers).toHaveLength(2);
      expect(d.topDrivers[0].driverId).toBe(b.driver.userId); // the bonus puts b first
      expect(d.topDrivers[0].earnings).toBeGreaterThan(d.topDrivers[1].earnings);
      expect(d.topOwners).toHaveLength(2);
      expect((await get("/api/analytics/leaderboards?limit=1")).body.data.topDrivers).toHaveLength(1);
      expect((await get("/api/analytics/leaderboards?limit=500")).status).toBe(400);
      expect(a.driver.userId).toBeTruthy();
    });
  });

  describe("system health", () => {
    it("reports ok with dependency latencies, queues, pool and process info when nothing is wrong", async () => {
      const res = await get("/api/admin/system/health");
      expect(res.status).toBe(200);
      const h = res.body.data;
      expect(h.status).toBe("ok");
      expect(h.alerts).toEqual([]);
      expect(h.dependencies.postgres).toMatchObject({ status: "up" });
      expect(h.dependencies.redis).toMatchObject({ status: "up" });
      expect(h.dependencies.postgres.latencyMs).toBeGreaterThanOrEqual(0);
      expect(h.queues.map((x: any) => x.name).sort()).toEqual(["marketplace", "notifications", "rentals"]);
      expect(h.queues.every((x: any) => x.status === "up")).toBe(true);
      expect(h.invariants).toEqual({ stuckPayments: 0, unsettledRides: 0, overdueRentalHolds: 0, stuckPayouts: 0, openDepositRefunds: 0 });
      expect(h.database.poolTotal).toBeGreaterThanOrEqual(1);
      expect(h.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it("goes DEGRADED (not down) when a payment is stuck in PROCESSING", async () => {
      const a = await paidRide();
      await pool.query(`UPDATE payments SET status = 'PROCESSING', updated_at = now() - interval '10 minutes' WHERE id = $1`, [a.paymentId]);
      const h = (await get("/api/admin/system/health")).body.data;
      expect(h.status).toBe("degraded");
      expect(h.invariants.stuckPayments).toBe(1);
      expect(h.alerts.join(" ")).toMatch(/stuck in PROCESSING/);
    });

    it("flags a paid ride whose earnings were never split, and clears once reconcile runs", async () => {
      const a = await paidRide();
      await pool.query(`DELETE FROM driver_earnings`);
      await pool.query(`DELETE FROM owner_earnings`);
      await pool.query(`DELETE FROM platform_commissions`);
      await pool.query(`UPDATE rides SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [a.rideId]);
      let h = (await get("/api/admin/system/health")).body.data;
      expect(h.status).toBe("degraded");
      expect(h.invariants.unsettledRides).toBe(1);

      await request(app).post("/api/earnings/reconcile").set(bearer(admin.accessToken)).send({});
      h = (await get("/api/admin/system/health")).body.data;
      expect(h.invariants.unsettledRides).toBe(0);
      expect(h.status).toBe("ok");
    });

    it("a recent problem is not flagged yet (grace period), so a payment in flight does not raise a false alarm", async () => {
      const a = await paidRide();
      await pool.query(`UPDATE payments SET status = 'PROCESSING', updated_at = now() WHERE id = $1`, [a.paymentId]);
      expect((await get("/api/admin/system/health")).body.data.status).toBe("ok");
    });

    it("reports DOWN with the error when the database check fails, without throwing", async () => {
      jest.spyOn(pool, "query").mockImplementation(((sql: string) => (typeof sql === "string" && sql === "SELECT 1" ? Promise.reject(new Error("connection refused")) : Promise.reject(new Error("db down")))) as any);
      const { systemHealthService } = await import("../../src/modules/admin/services/systemHealth.service");
      const h = await systemHealthService.report();
      expect(h.status).toBe("down");
      expect(h.dependencies.postgres).toMatchObject({ status: "down", error: "connection refused" });
      expect(h.invariants).toBeNull();
    });

    it("a failed job in any queue is surfaced as an alert", async () => {
      const { getRentalQueue } = await import("../../src/queues/rentalQueue");
      jest.spyOn(getRentalQueue(), "getJobCounts").mockResolvedValue({ waiting: 0, active: 0, delayed: 0, failed: 3 } as any);
      const h = (await get("/api/admin/system/health")).body.data;
      expect(h.status).toBe("degraded");
      expect(h.alerts).toContain("queue rentals has 3 failed job(s)");
    });
  });

  it("healthCounters is a single cheap query (no N+1)", async () => {
    const spy = jest.spyOn(pool, "query");
    await analyticsRepository.healthCounters();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

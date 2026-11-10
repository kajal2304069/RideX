import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";
import { makeAdmin, registerUser, resetPaymentTables } from "./paymentFixtures";
import { createOwnerVehicle, ensureRentalVehicleType, registerOwner } from "./rentalFixtures";
import { maintenanceService } from "../../src/modules/maintenance/services/maintenance.service";
import { notificationsService } from "../../src/modules/notifications/services/notifications.service";
import { getMaintenanceQueue, MAINTENANCE_SCHEDULER_ID, scheduleMaintenanceScan } from "../../src/queues/maintenanceQueue";

const app = createApp();
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const DAY = 86_400_000;
const day = (offset: number, base = new Date()) => new Date(base.getTime() + offset * DAY).toISOString().slice(0, 10);
let vt: string;

async function setup() {
  const owner = await registerOwner(app);
  const vehicleId = await createOwnerVehicle(app, owner, vt);
  return { owner, vehicleId };
}
const addRecord = (t: { accessToken: string }, vehicleId: string, body: object) => request(app).post(`/api/maintenance/vehicles/${vehicleId}/records`).set(bearer(t.accessToken)).send(body);
const addDoc = (t: { accessToken: string }, vehicleId: string, body: object) => request(app).post(`/api/maintenance/vehicles/${vehicleId}/documents`).set(bearer(t.accessToken)).send(body);

describe("Vehicle maintenance, documents, incidents and reminders (live DB + Redis + BullMQ)", () => {
  beforeAll(async () => { vt = await ensureRentalVehicleType("MAINT_TEST", "BOTH"); });
  beforeEach(async () => { await resetPaymentTables(); await redis.flushdb(); });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await closeTestDb(); redis.disconnect(); });

  describe("records", () => {
    it("records a service and schedules the next one from the service type (oil change: 180 days)", async () => {
      const { owner, vehicleId } = await setup();
      const performed = "2026-01-10T00:00:00.000Z";
      const res = await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", cost: 1200.5, odometerKm: 45000, performedAt: performed });
      expect(res.status).toBe(201);
      expect(res.body.data.record).toMatchObject({ serviceType: "OIL_CHANGE", cost: 1200.5, odometerKm: 45000, source: "OWNER" });
      expect(Date.parse(res.body.data.record.nextDueAt) - Date.parse(performed)).toBe(180 * DAY);
    });

    it("types with no default schedule have none; an explicit date or null overrides", async () => {
      const { owner, vehicleId } = await setup();
      expect((await addRecord(owner, vehicleId, { serviceType: "BODY_WORK" })).body.data.record.nextDueAt).toBeNull();
      const custom = new Date(Date.now() + 40 * DAY).toISOString();
      expect((await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", nextDueAt: custom })).body.data.record.nextDueAt).toBe(custom);
      expect((await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", nextDueAt: null })).body.data.record.nextDueAt).toBeNull();
    });

    it("validation: unknown type, negative cost, future service, next-before-this, extra fields", async () => {
      const { owner, vehicleId } = await setup();
      expect((await addRecord(owner, vehicleId, { serviceType: "FLUX_CAPACITOR" })).status).toBe(400);
      expect((await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", cost: -1 })).status).toBe(400);
      expect((await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", performedAt: new Date(Date.now() + 10 * DAY).toISOString() })).status).toBe(400);
      expect((await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", performedAt: "2026-03-01T00:00:00Z", nextDueAt: "2026-02-01T00:00:00Z" })).status).toBe(400);
      expect((await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", source: "GARAGE" })).status).toBe(400);
    });

    it("only the owner can touch a vehicle's maintenance; others get 404; riders get 403", async () => {
      const { owner, vehicleId } = await setup();
      const other = await registerOwner(app);
      expect((await addRecord(other, vehicleId, { serviceType: "OIL_CHANGE" })).status).toBe(404);
      expect((await request(app).get(`/api/maintenance/vehicles/${vehicleId}`).set(bearer(other.accessToken))).status).toBe(404);
      const rider = await registerUser(app, ["RIDER"]);
      expect((await addRecord(rider, vehicleId, { serviceType: "OIL_CHANGE" })).status).toBe(403);
      expect((await request(app).get(`/api/maintenance/vehicles/${vehicleId}`).set(bearer(owner.accessToken))).status).toBe(200);
    });
  });

  describe("documents and incidents", () => {
    it("stores documents, rejects a duplicate period and an issue date after expiry, and deletes", async () => {
      const { owner, vehicleId } = await setup();
      const body = { docType: "INSURANCE", documentNumber: "POL-123", issuedAt: day(-300), expiresAt: day(65) };
      const first = await addDoc(owner, vehicleId, body);
      expect(first.status).toBe(201);
      expect((await addDoc(owner, vehicleId, body)).status).toBe(409);
      expect((await addDoc(owner, vehicleId, { docType: "PERMIT", issuedAt: day(10), expiresAt: day(5) })).status).toBe(400);
      expect((await addDoc(owner, vehicleId, { docType: "PERMIT", expiresAt: "31-12-2030" })).status).toBe(400);
      expect((await addDoc(owner, vehicleId, { docType: "PUC", expiresAt: day(5) })).status).toBe(400);
      // a renewal (same type, later expiry) is a new row; history is kept
      expect((await addDoc(owner, vehicleId, { ...body, issuedAt: day(65), expiresAt: day(430) })).status).toBe(201);
      const del = await request(app).delete(`/api/maintenance/vehicles/${vehicleId}/documents/${first.body.data.document.id}`).set(bearer(owner.accessToken));
      expect(del.status).toBe(204);
      expect((await request(app).delete(`/api/maintenance/vehicles/${vehicleId}/documents/${first.body.data.document.id}`).set(bearer(owner.accessToken))).status).toBe(404);
    });

    it("records accident history and returns the whole picture in one overview", async () => {
      const { owner, vehicleId } = await setup();
      const inc = await request(app).post(`/api/maintenance/vehicles/${vehicleId}/incidents`).set(bearer(owner.accessToken))
        .send({ occurredAt: day(-90), severity: "MODERATE", description: "Rear bumper hit in parking", repairCost: 8500 });
      expect(inc.status).toBe(201);
      expect((await request(app).post(`/api/maintenance/vehicles/${vehicleId}/incidents`).set(bearer(owner.accessToken)).send({ occurredAt: day(30), severity: "MINOR", description: "future" })).status).toBe(400);
      await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", cost: 1000 });
      await addRecord(owner, vehicleId, { serviceType: "BRAKE_REPAIR", cost: 2500.25 });
      await addDoc(owner, vehicleId, { docType: "POLLUTION", expiresAt: day(100) });
      const o = (await request(app).get(`/api/maintenance/vehicles/${vehicleId}`).set(bearer(owner.accessToken))).body.data;
      expect(o.records).toHaveLength(2);
      expect(o.documents).toHaveLength(1);
      expect(o.incidents).toHaveLength(1);
      expect(o.incidents[0]).toMatchObject({ severity: "MODERATE", repairCost: 8500 });
      expect(o.totalMaintenanceCost).toBe(3500.25);
    });
  });

  describe("reminder scan", () => {
    const notified = () => jest.spyOn(notificationsService, "notify").mockResolvedValue();

    it("notifies at the right stage for services and documents, and ignores things that are far off", async () => {
      const { owner, vehicleId } = await setup();
      const now = new Date("2026-06-15T10:00:00Z");
      const spy = notified();
      await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", performedAt: "2026-01-01T00:00:00Z", nextDueAt: "2026-06-10T00:00:00Z" }); // overdue
      await addRecord(owner, vehicleId, { serviceType: "BRAKE_REPAIR", performedAt: "2026-01-01T00:00:00Z", nextDueAt: "2026-06-19T00:00:00Z" }); // 7d
      await addRecord(owner, vehicleId, { serviceType: "TYRE_REPLACEMENT", performedAt: "2026-01-01T00:00:00Z", nextDueAt: "2026-09-01T00:00:00Z" }); // far
      await addDoc(owner, vehicleId, { docType: "INSURANCE", expiresAt: "2026-06-16" }); // 1d
      await addDoc(owner, vehicleId, { docType: "PERMIT", expiresAt: "2026-06-01" }); // expired
      await addDoc(owner, vehicleId, { docType: "FITNESS", expiresAt: "2027-01-01" }); // far

      const r = await maintenanceService.scan(now);
      expect(r).toMatchObject({ services: 2, documents: 2, notificationsQueued: 4 });
      const calls = spy.mock.calls.map((c) => ({ type: c[1], stage: (c[3] as { stage: string }).stage }));
      expect(calls).toEqual(expect.arrayContaining([
        { type: "SERVICE_DUE", stage: "OVERDUE" }, { type: "SERVICE_DUE", stage: "DUE_7D" },
        { type: "DOCUMENT_EXPIRING", stage: "EXPIRES_1D" }, { type: "DOCUMENT_EXPIRING", stage: "EXPIRED" },
      ]));
      expect(spy.mock.calls.every((c) => c[0] === owner.userId)).toBe(true);
    });

    it("a newer service supersedes the old schedule: a serviced vehicle is no longer overdue", async () => {
      const { owner, vehicleId } = await setup();
      const now = new Date("2026-06-15T10:00:00Z");
      const spy = notified();
      await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", performedAt: "2026-01-01T00:00:00Z", nextDueAt: "2026-06-01T00:00:00Z" });
      expect((await maintenanceService.scan(now)).services).toBe(1);
      await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", performedAt: "2026-06-14T00:00:00Z", nextDueAt: "2026-12-11T00:00:00Z" });
      spy.mockClear();
      expect((await maintenanceService.scan(now)).services).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    });

    it("a renewed document supersedes the expired one", async () => {
      const { owner, vehicleId } = await setup();
      const now = new Date("2026-06-15T10:00:00Z");
      notified();
      await addDoc(owner, vehicleId, { docType: "INSURANCE", expiresAt: "2026-06-10" });
      expect((await maintenanceService.scan(now)).documents).toBe(1);
      await addDoc(owner, vehicleId, { docType: "INSURANCE", expiresAt: "2027-06-10" });
      expect((await maintenanceService.scan(now)).documents).toBe(0);
    });

    it("also tells the driver currently assigned to the vehicle", async () => {
      const { owner, vehicleId } = await setup();
      const driver = await registerUser(app, ["DRIVER"]);
      await pool.query(`UPDATE vehicles SET current_driver_id = $2 WHERE id = $1`, [vehicleId, driver.userId]);
      const spy = notified();
      await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", performedAt: "2026-01-01T00:00:00Z", nextDueAt: "2026-06-16T00:00:00Z" });
      await maintenanceService.scan(new Date("2026-06-15T10:00:00Z"));
      expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual([owner.userId, driver.userId].sort());
    });

    it("the stage is part of the dedupe key, so re-running the scan cannot double-notify but a new stage can", async () => {
      const { owner, vehicleId } = await setup();
      const spy = notified();
      const rec = (await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", performedAt: "2026-01-01T00:00:00Z", nextDueAt: "2026-06-20T00:00:00Z" })).body.data.record;
      await maintenanceService.scan(new Date("2026-06-15T10:00:00Z")); // DUE_7D
      await maintenanceService.scan(new Date("2026-06-15T18:00:00Z")); // DUE_7D again
      await maintenanceService.scan(new Date("2026-06-19T12:00:00Z")); // DUE_1D
      const ids = spy.mock.calls.map((c) => c[2]);
      expect(ids).toEqual([`${rec.id}__DUE_7D`, `${rec.id}__DUE_7D`, `${rec.id}__DUE_1D`]); // identical ids for the repeat => the notification layer drops it
      expect(new Set(ids).size).toBe(2);
    });

    it("end to end through the real notification table: the second scan creates no second row", async () => {
      const { owner, vehicleId } = await setup();
      await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", performedAt: "2026-01-01T00:00:00Z", nextDueAt: "2026-06-16T00:00:00Z" });
      const job = jest.spyOn(notificationsService, "notify").mockImplementation(async (userId, type, entityId, data) => {
        await notificationsService.process({ userId, type, entityId, data: data ?? {} });
      });
      await maintenanceService.scan(new Date("2026-06-15T10:00:00Z"));
      await maintenanceService.scan(new Date("2026-06-15T11:00:00Z"));
      expect(job).toHaveBeenCalledTimes(2);
      const rows = (await pool.query(`SELECT title, body FROM notifications WHERE user_id = $1 AND type = 'SERVICE_DUE'`, [owner.userId])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toContain("oil change");
    });

    it("one failing notification does not stop the rest of the scan", async () => {
      const { owner, vehicleId } = await setup();
      const spy = jest.spyOn(notificationsService, "notify").mockRejectedValueOnce(new Error("queue down")).mockResolvedValue();
      await addRecord(owner, vehicleId, { serviceType: "OIL_CHANGE", performedAt: "2026-01-01T00:00:00Z", nextDueAt: "2026-06-16T00:00:00Z" });
      await addDoc(owner, vehicleId, { docType: "INSURANCE", expiresAt: "2026-06-16" });
      const r = await maintenanceService.scan(new Date("2026-06-15T10:00:00Z"));
      expect(spy).toHaveBeenCalledTimes(2);
      expect(r.notificationsQueued).toBe(1);
    });

    it("the owner's upcoming view shows only their own fleet, with stages", async () => {
      const a = await setup();
      const b = await setup();
      await addRecord(a.owner, a.vehicleId, { serviceType: "OIL_CHANGE", performedAt: "2026-01-01T00:00:00Z", nextDueAt: new Date(Date.now() - DAY).toISOString() });
      await addDoc(b.owner, b.vehicleId, { docType: "INSURANCE", expiresAt: day(3) });
      const mine = (await request(app).get("/api/maintenance/upcoming").set(bearer(a.owner.accessToken))).body.data;
      expect(mine.services).toHaveLength(1);
      expect(mine.services[0]).toMatchObject({ vehicleId: a.vehicleId, stage: "OVERDUE" });
      expect(mine.documents).toHaveLength(0);
      expect((await request(app).get("/api/maintenance/upcoming").set(bearer(b.owner.accessToken))).body.data.documents[0].stage).toBe("EXPIRES_7D");
    });

    it("admin can trigger the scan (audited); owners cannot", async () => {
      const { owner } = await setup();
      notified();
      const admin = await makeAdmin(app);
      expect((await request(app).post("/api/maintenance/scan").set(bearer(owner.accessToken))).status).toBe(403);
      const res = await request(app).post("/api/maintenance/scan").set(bearer(admin.accessToken));
      expect(res.status).toBe(200);
      expect(res.body.data.scan).toMatchObject({ services: 0, documents: 0 });
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'maintenance.scan_run'`)).rows[0].n).toBe(1);
    });
  });

  describe("daily schedule (BullMQ)", () => {
    it("registering the schedule is idempotent: any number of workers booting yields ONE repeatable scheduler", async () => {
      await getMaintenanceQueue().obliterate({ force: true }).catch(() => undefined);
      await Promise.all([1, 2, 3, 4].map(() => scheduleMaintenanceScan()));
      const schedulers = await getMaintenanceQueue().getJobSchedulers();
      expect(schedulers.filter((s) => s.key === MAINTENANCE_SCHEDULER_ID)).toHaveLength(1);
      expect(schedulers[0].pattern).toBe("0 6 * * *");
    });
  });
});

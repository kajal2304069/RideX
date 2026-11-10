import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";
import { ensurePaymentVehicleType, idemKey, makeAdmin, readyDriver, registerUser, resetPaymentTables } from "./paymentFixtures";
import * as io from "../../src/websocket/io";
import { MAX_MESSAGES_PER_MINUTE } from "../../src/modules/chat/services/chat.service";
import { notificationsService } from "../../src/modules/notifications/services/notifications.service";

const app = createApp();
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
let vt: string;
let admin: { userId: string; accessToken: string };

async function acceptedRide() {
  const driver = await readyDriver(app, vt, admin.accessToken);
  const rider = await registerUser(app, ["RIDER"]);
  const ride = await request(app).post("/api/rides/request").set(bearer(rider.accessToken)).send({
    pickup: { lat: 12.9716, lng: 77.5946, address: "MG Road" }, dropoff: { lat: 12.935, lng: 77.6245, address: "Koramangala" }, vehicleTypeId: vt, idempotencyKey: idemKey(),
  });
  const rideId = ride.body.data.ride.id as string;
  const acc = await request(app).post(`/api/rides/${rideId}/accept`).set(bearer(driver.accessToken));
  expect(acc.status).toBe(200);
  return { rideId, rider, driver };
}
const say = (t: { accessToken: string }, rideId: string, body: string) => request(app).post(`/api/chat/rides/${rideId}/messages`).set(bearer(t.accessToken)).send({ body });

describe("Chat + support (live DB + Redis)", () => {
  beforeAll(async () => { vt = await ensurePaymentVehicleType("CHAT_TEST"); });
  beforeEach(async () => { await resetPaymentTables(); await pool.query(`TRUNCATE support_tickets, messages CASCADE`); await redis.flushdb(); admin = await makeAdmin(app); });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await closeTestDb(); redis.disconnect(); });

  describe("ride chat", () => {
    it("rider and driver exchange messages; each is saved and pushed to the ride room", async () => {
      const { rideId, rider, driver } = await acceptedRide();
      const emit = jest.spyOn(io, "emitToRoom");
      const a = await say(rider, rideId, "  I am at the blue gate  ");
      expect(a.status).toBe(201);
      expect(a.body.data.message).toMatchObject({ senderId: rider.userId, body: "I am at the blue gate" }); // trimmed
      const b = await say(driver, rideId, "On my way");
      expect(b.status).toBe(201);
      expect(emit).toHaveBeenCalledWith(io.rideRoom(rideId), "chat:message", expect.objectContaining({ body: "On my way", senderId: driver.userId }));
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM messages WHERE ride_id = $1`, [rideId])).rows[0].n).toBe(2);
    });

    it("history is newest-first and keyset-paginated with no gaps or repeats", async () => {
      const { rideId, rider } = await acceptedRide();
      for (let i = 1; i <= 5; i++) await say(rider, rideId, `m${i}`);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let g = 0; g < 5; g++) {
        const res: request.Response = await request(app).get(`/api/chat/rides/${rideId}/messages?limit=2${cursor ? `&cursor=${cursor}` : ""}`).set(bearer(rider.accessToken));
        expect(res.status).toBe(200);
        seen.push(...res.body.data.messages.map((m: { body: string }) => m.body));
        cursor = res.body.data.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(["m5", "m4", "m3", "m2", "m1"]);
    });

    it("a stranger gets 404 on read and write (the ride's existence is not revealed)", async () => {
      const { rideId } = await acceptedRide();
      const stranger = await registerUser(app, ["RIDER"]);
      expect((await say(stranger, rideId, "hi")).status).toBe(404);
      expect((await request(app).get(`/api/chat/rides/${rideId}/messages`).set(bearer(stranger.accessToken))).status).toBe(404);
      expect((await request(app).get(`/api/chat/rides/${rideId}/messages`)).status).toBe(401);
    });

    it("validation: empty, whitespace-only, too long, unknown fields", async () => {
      const { rideId, rider } = await acceptedRide();
      expect((await say(rider, rideId, "")).status).toBe(400);
      expect((await say(rider, rideId, "    ")).status).toBe(400);
      expect((await say(rider, rideId, "x".repeat(1001))).status).toBe(400);
      expect((await request(app).post(`/api/chat/rides/${rideId}/messages`).set(bearer(rider.accessToken)).send({ body: "hi", senderId: "x" })).status).toBe(400);
    });

    it("is closed until a driver accepts", async () => {
      const rider = await registerUser(app, ["RIDER"]);
      const ride = await request(app).post("/api/rides/request").set(bearer(rider.accessToken)).send({
        pickup: { lat: 12.97, lng: 77.59, address: "A" }, dropoff: { lat: 12.93, lng: 77.62, address: "B" }, vehicleTypeId: vt, idempotencyKey: idemKey(),
      });
      expect((await say(rider, ride.body.data.ride.id, "anyone?")).status).toBe(409);
    });

    it("closes 24h after the ride ends", async () => {
      const { rideId, rider } = await acceptedRide();
      await pool.query(`UPDATE rides SET completed_at = now() - interval '2 hours' WHERE id = $1`, [rideId]);
      expect((await say(rider, rideId, "left my phone")).status).toBe(201);
      await pool.query(`UPDATE rides SET completed_at = now() - interval '25 hours' WHERE id = $1`, [rideId]);
      expect((await say(rider, rideId, "too late")).status).toBe(409);
    });

    it("rate limit: the 21st message in a minute is 429; another user is unaffected; Redis failure fails open", async () => {
      const { rideId, rider, driver } = await acceptedRide();
      for (let i = 0; i < MAX_MESSAGES_PER_MINUTE; i++) expect((await say(rider, rideId, `m${i}`)).status).toBe(201);
      expect((await say(rider, rideId, "one too many")).status).toBe(429);
      expect((await say(driver, rideId, "still fine")).status).toBe(201);
      jest.spyOn(redis, "incr").mockRejectedValueOnce(new Error("redis down"));
      expect((await say(rider, rideId, "redis is down")).status).toBe(201);
    });
  });

  describe("support tickets", () => {
    const open = (t: { accessToken: string }, subject = "Driver was rude", extra: object = {}) =>
      request(app).post("/api/support/tickets").set(bearer(t.accessToken)).send({ subject, description: "details", ...extra });

    it("a user opens a ticket and sees it (and only theirs)", async () => {
      const u = await registerUser(app, ["RIDER"]);
      const other = await registerUser(app, ["RIDER"]);
      const res = await open(u, "Charged twice", { priority: "HIGH" });
      expect(res.status).toBe(201);
      expect(res.body.data.ticket).toMatchObject({ subject: "Charged twice", status: "OPEN", priority: "HIGH", userId: u.userId });
      expect((await request(app).get("/api/support/tickets").set(bearer(u.accessToken))).body.data.tickets).toHaveLength(1);
      expect((await request(app).get("/api/support/tickets").set(bearer(other.accessToken))).body.data.tickets).toHaveLength(0);
      expect((await request(app).get(`/api/support/tickets/${res.body.data.ticket.id}`).set(bearer(other.accessToken))).status).toBe(404);
    });

    it("validation: subject length, priority, unknown fields", async () => {
      const u = await registerUser(app, ["RIDER"]);
      expect((await open(u, "hi")).status).toBe(400);
      expect((await open(u, "Valid subject", { priority: "WHENEVER" })).status).toBe(400);
      expect((await open(u, "Valid subject", { status: "RESOLVED" })).status).toBe(400);
    });

    it("CONCURRENCY: 15 simultaneous tickets from one user create exactly 10", async () => {
      const u = await registerUser(app, ["RIDER"]);
      const res = await Promise.all(Array.from({ length: 15 }, (_, i) => open(u, `Ticket number ${i}`)));
      expect(res.filter((r) => r.status === 201)).toHaveLength(10);
      expect(res.filter((r) => r.status === 429)).toHaveLength(5);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM support_tickets WHERE user_id = $1`, [u.userId])).rows[0].n).toBe(10);
    });

    it("conversation: staff reply notifies the customer; a customer reply to a RESOLVED ticket reopens it", async () => {
      const u = await registerUser(app, ["RIDER"]);
      const id = (await open(u)).body.data.ticket.id as string;
      const notify = jest.spyOn(notificationsService, "notify").mockResolvedValue();

      const staff = await request(app).post(`/api/support/tickets/${id}/messages`).set(bearer(admin.accessToken)).send({ body: "Sorry! Looking into it." });
      expect(staff.status).toBe(201);
      expect(staff.body.data.message.isStaff).toBe(true);
      expect(notify).toHaveBeenCalledWith(u.userId, "SUPPORT_REPLY", expect.any(String), expect.anything());

      await request(app).patch(`/api/support/tickets/${id}`).set(bearer(admin.accessToken)).send({ status: "RESOLVED" });
      const back = await request(app).post(`/api/support/tickets/${id}/messages`).set(bearer(u.accessToken)).send({ body: "Not fixed" });
      expect(back.status).toBe(201);
      const t = await request(app).get(`/api/support/tickets/${id}`).set(bearer(u.accessToken));
      expect(t.body.data.ticket.status).toBe("OPEN");
      expect(t.body.data.ticket.resolvedAt).toBeNull();
      expect(t.body.data.messages.map((m: { body: string }) => m.body)).toEqual(["Sorry! Looking into it.", "Not fixed"]);
    });

    it("staff triage: state machine enforced, closed is final, every change audited, customers cannot triage", async () => {
      const u = await registerUser(app, ["RIDER"]);
      const id = (await open(u)).body.data.ticket.id as string;
      const patch = (b: object, t = admin) => request(app).patch(`/api/support/tickets/${id}`).set(bearer(t.accessToken)).send(b);

      expect((await patch({ status: "IN_PROGRESS", priority: "URGENT", assignToMe: true })).body.data.ticket).toMatchObject({ status: "IN_PROGRESS", priority: "URGENT", assignedTo: admin.userId });
      expect((await patch({ status: "CLOSED" })).status).toBe(200);
      expect((await patch({ status: "OPEN" })).status).toBe(409); // CLOSED is final
      expect((await patch({ priority: "LOW" })).status).toBe(409);
      expect((await request(app).post(`/api/support/tickets/${id}/messages`).set(bearer(u.accessToken)).send({ body: "hello?" })).status).toBe(409);
      expect((await patch({ status: "RESOLVED" }, u as never)).status).toBe(403);
      expect((await patch({})).status).toBe(400);
      const audits = (await pool.query(`SELECT action FROM audit_logs WHERE entity_id = $1`, [id])).rows;
      expect(audits.length).toBeGreaterThanOrEqual(2);
      expect(audits.every((a: { action: string }) => a.action === "support.ticket_updated")).toBe(true);
    });

    it("staff queue lists every ticket with the customer's email and filters by status/priority; customers cannot use it", async () => {
      const a = await registerUser(app, ["RIDER"]);
      const b = await registerUser(app, ["RIDER"]);
      await open(a, "First problem", { priority: "LOW" });
      const second = (await open(b, "Second problem", { priority: "URGENT" })).body.data.ticket.id;
      await request(app).patch(`/api/support/tickets/${second}`).set(bearer(admin.accessToken)).send({ status: "IN_PROGRESS" });

      const all = await request(app).get("/api/support/tickets/all").set(bearer(admin.accessToken));
      expect(all.body.data.tickets).toHaveLength(2);
      expect(all.body.data.tickets[0].userEmail).toBeTruthy();
      expect((await request(app).get("/api/support/tickets/all?status=IN_PROGRESS").set(bearer(admin.accessToken))).body.data.tickets).toHaveLength(1);
      expect((await request(app).get("/api/support/tickets/all?priority=LOW").set(bearer(admin.accessToken))).body.data.tickets[0].subject).toBe("First problem");
      expect((await request(app).get("/api/support/tickets/all").set(bearer(a.accessToken))).status).toBe(403);
    });

    it("a replayed bad reply (empty) is rejected, and the DB enforces the subject-length constraint", async () => {
      const u = await registerUser(app, ["RIDER"]);
      const id = (await open(u)).body.data.ticket.id as string;
      expect((await request(app).post(`/api/support/tickets/${id}/messages`).set(bearer(u.accessToken)).send({ body: "   " })).status).toBe(400);
      await expect(pool.query(`UPDATE support_tickets SET subject = 'ab' WHERE id = $1`, [id])).rejects.toMatchObject({ code: "23514" });
    });
  });
});

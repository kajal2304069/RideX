import request from "supertest";
import { Worker } from "bullmq";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";
import { getNotificationQueue } from "../../src/queues/notificationQueue";
import { startNotificationWorker } from "../../src/workers/notificationWorker";
import { notificationsService } from "../../src/modules/notifications/services/notifications.service";
import { startNotificationSubscriber, RealtimeNotification } from "../../src/modules/notifications/services/realtimeBridge";
import { MockEmailChannel, setEmailChannelForTests } from "../../src/modules/notifications/services/channels/EmailChannel";
import { advanceBooking, bookingKey, createGarage, registerGarageOwner } from "./garageFixtures";
import { createCompletedRide, ensurePaymentVehicleType, idemKey, makeAdmin, readyDriver, registerUser, resetPaymentTables } from "./paymentFixtures";

const app = createApp();
let vehicleTypeId: string;
let worker: Worker;
let stopSub: () => Promise<void>;
let live: RealtimeNotification[];
let email: MockEmailChannel;

async function waitFor<T>(fn: () => Promise<T | false | null | undefined>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 40));
  }
}

const rowsFor = async (userId: string) => (await pool.query(`SELECT type, read_at, email_sent_at FROM notifications WHERE user_id = $1 ORDER BY created_at`, [userId])).rows;
const types = async (userId: string) => (await rowsFor(userId)).map((r) => r.type);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("Notifications + BullMQ (live Postgres, Redis, worker)", () => {
  beforeAll(async () => {
    vehicleTypeId = await ensurePaymentVehicleType("NOTIF_TEST_SEDAN");
  });
  beforeEach(async () => {
    await resetPaymentTables();
    await pool.query(`TRUNCATE notifications`);
    await redis.flushdb();
    live = [];
    email = new MockEmailChannel();
    setEmailChannelForTests(email);
    stopSub = await startNotificationSubscriber((m) => live.push(m));
    worker = startNotificationWorker(3);
    await worker.waitUntilReady();
  });
  afterEach(async () => {
    await worker.close();
    await stopSub();
  });
  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  describe("delivery pipeline", () => {
    it("enqueue -> worker stores the row -> realtime publish reaches the subscriber", async () => {
      const user = await registerUser(app, ["RIDER"]);

      await notificationsService.notify(user.userId, "DRIVER_ARRIVED", "ride-1");

      await waitFor(async () => (await rowsFor(user.userId)).length === 1);
      await waitFor(async () => live.length === 1);
      expect(live[0].userId).toBe(user.userId);
      expect(live[0].notification.title).toBe("Driver has arrived");
      expect(email.sent).toHaveLength(0); // in-app only type
    });

    it("sends an email for email-worthy types, exactly once", async () => {
      const user = await registerUser(app, ["RIDER"]);

      await notificationsService.notify(user.userId, "RIDE_COMPLETED", "ride-2", { totalFare: 150, currency: "INR" });

      await waitFor(async () => email.sent.length === 1);
      expect(email.sent[0].to).toBe(user.email);
      expect(email.sent[0].text).toContain("INR 150.00");
      const [row] = await rowsFor(user.userId);
      expect(row.email_sent_at).not.toBeNull();
    });

    it("rendered text is produced by the worker, not stored on the job", async () => {
      const user = await registerUser(app, ["RIDER"]);
      await notificationsService.notify(user.userId, "TRIP_STARTED", "ride-3");
      await waitFor(async () => (await rowsFor(user.userId)).length === 1);

      const done = await getNotificationQueue().getCompleted();
      expect(JSON.stringify(done[0].data)).not.toContain("Trip started");
    });
  });

  describe("duplicates", () => {
    it("the same event enqueued twice produces one notification (BullMQ jobId)", async () => {
      const user = await registerUser(app, ["RIDER"]);

      await Promise.all([1, 2, 3].map(() => notificationsService.notify(user.userId, "RIDE_ASSIGNED", "ride-4")));

      await waitFor(async () => (await rowsFor(user.userId)).length >= 1);
      await new Promise((r) => setTimeout(r, 300));
      expect(await types(user.userId)).toEqual(["RIDE_ASSIGNED"]);
    });

    it("even after BullMQ has forgotten the job, the DB unique index blocks a duplicate", async () => {
      const user = await registerUser(app, ["RIDER"]);
      const job = { userId: user.userId, type: "RIDE_COMPLETED" as const, entityId: "ride-5", data: { totalFare: 10, currency: "INR" } };

      // Run the consumer logic directly, twice, bypassing the queue entirely.
      await notificationsService.process(job);
      await notificationsService.process(job);

      expect(await types(user.userId)).toEqual(["RIDE_COMPLETED"]);
      expect(email.sent).toHaveLength(1);
    });
  });

  describe("retries and the dead-letter set", () => {
    it("retries a failing email with backoff and ends with the row stored and the email sent once", async () => {
      const user = await registerUser(app, ["RIDER"]);
      email.failNext(2);

      await notificationsService.notify(user.userId, "PAYMENT_SUCCESS", "pay-1", { amount: 99, currency: "INR" });

      await waitFor(async () => email.sent.length === 1);
      const [row] = await rowsFor(user.userId);
      expect(row.email_sent_at).not.toBeNull();
      expect(await types(user.userId)).toEqual(["PAYMENT_SUCCESS"]);
      expect(live).toHaveLength(1); // live push happened once, not once per attempt
      const job = (await getNotificationQueue().getCompleted())[0];
      expect(job.attemptsMade).toBe(3);
    });

    it("after 5 failed attempts the job lands in the failed set; the in-app row still exists", async () => {
      const user = await registerUser(app, ["RIDER"]);
      email.failNext(100);

      await notificationsService.notify(user.userId, "PAYMENT_SUCCESS", "pay-2", { amount: 5, currency: "INR" });

      const failed = await waitFor(async () => {
        const f = await getNotificationQueue().getFailed();
        return f.length === 1 ? f : false;
      });
      expect(failed[0].attemptsMade).toBe(5);
      expect((await rowsFor(user.userId))[0].email_sent_at).toBeNull();
      expect(email.sent).toHaveLength(0);
    });

    it("a permanent error (unknown user) fails on the first attempt without retrying", async () => {
      await notificationsService.notify("00000000-0000-4000-8000-000000000000", "RIDE_ASSIGNED", "ride-6");

      const failed = await waitFor(async () => {
        const f = await getNotificationQueue().getFailed();
        return f.length === 1 ? f : false;
      });
      expect(failed[0].attemptsMade).toBe(1);
    });
  });

  describe("REST API", () => {
    it("lists, counts unread, marks one read, marks all read", async () => {
      const user = await registerUser(app, ["RIDER"]);
      await notificationsService.notify(user.userId, "RIDE_ASSIGNED", "a");
      await notificationsService.notify(user.userId, "DRIVER_ARRIVED", "b");
      await notificationsService.notify(user.userId, "TRIP_STARTED", "c");
      await waitFor(async () => (await rowsFor(user.userId)).length === 3);

      const count = await request(app).get("/api/notifications/unread-count").set(auth(user.accessToken));
      expect(count.body.data.unread).toBe(3);

      const list = await request(app).get("/api/notifications").set(auth(user.accessToken));
      expect(list.body.data.notifications).toHaveLength(3);
      const first = list.body.data.notifications[0];

      const read = await request(app).patch(`/api/notifications/${first.id}/read`).set(auth(user.accessToken));
      expect(read.body.data.notification.readAt).not.toBeNull();

      const unreadOnly = await request(app).get("/api/notifications?unreadOnly=true").set(auth(user.accessToken));
      expect(unreadOnly.body.data.notifications).toHaveLength(2);

      const all = await request(app).post("/api/notifications/read-all").set(auth(user.accessToken));
      expect(all.body.data.updated).toBe(2);
      const after = await request(app).get("/api/notifications/unread-count").set(auth(user.accessToken));
      expect(after.body.data.unread).toBe(0);
    });

    it("paginates with limit and before", async () => {
      const user = await registerUser(app, ["RIDER"]);
      for (const id of ["p1", "p2", "p3"]) {
        await notificationsService.notify(user.userId, "RIDE_ASSIGNED", id);
        await waitFor(async () => (await rowsFor(user.userId)).length === Number(id[1]));
      }

      const page1 = await request(app).get("/api/notifications?limit=2").set(auth(user.accessToken));
      expect(page1.body.data.notifications).toHaveLength(2);
      const oldest = page1.body.data.notifications[1].createdAt;

      const page2 = await request(app).get(`/api/notifications?limit=2&before=${encodeURIComponent(oldest)}`).set(auth(user.accessToken));
      expect(page2.body.data.notifications).toHaveLength(1);
    });

    it("only shows a user their own notifications and refuses to mark someone else's read", async () => {
      const a = await registerUser(app, ["RIDER"]);
      const b = await registerUser(app, ["RIDER"]);
      await notificationsService.notify(a.userId, "RIDE_ASSIGNED", "x");
      await waitFor(async () => (await rowsFor(a.userId)).length === 1);
      const id = (await pool.query(`SELECT id FROM notifications WHERE user_id = $1`, [a.userId])).rows[0].id;

      const bList = await request(app).get("/api/notifications").set(auth(b.accessToken));
      expect(bList.body.data.notifications).toHaveLength(0);
      const steal = await request(app).patch(`/api/notifications/${id}/read`).set(auth(b.accessToken));
      expect(steal.status).toBe(404);
    });

    it("validates query params and requires auth", async () => {
      const user = await registerUser(app, ["RIDER"]);
      expect((await request(app).get("/api/notifications?limit=0").set(auth(user.accessToken))).status).toBe(400);
      expect((await request(app).get("/api/notifications")).status).toBe(401);
      expect((await request(app).patch("/api/notifications/not-a-uuid/read").set(auth(user.accessToken))).status).toBe(400);
    });

    it("queue stats are admin-only", async () => {
      const user = await registerUser(app, ["RIDER"]);
      const admin = await makeAdmin(app);
      expect((await request(app).get("/api/notifications/admin/queue-stats").set(auth(user.accessToken))).status).toBe(403);
      const ok = await request(app).get("/api/notifications/admin/queue-stats").set(auth(admin.accessToken));
      expect(ok.status).toBe(200);
      expect(ok.body.data.queue).toHaveProperty("failed");
    });
  });

  describe("end to end: ride lifecycle and payment", () => {
    it("rider and driver receive the right notifications as the ride progresses and is paid", async () => {
      const admin = await makeAdmin(app);
      const { rideId, rider, driver } = await createCompletedRide(app, vehicleTypeId, admin);

      await waitFor(async () => (await types(rider.userId)).length >= 5);
      expect(await types(rider.userId)).toEqual(
        expect.arrayContaining(["RIDE_ASSIGNED", "DRIVER_ARRIVING", "DRIVER_ARRIVED", "TRIP_STARTED", "RIDE_COMPLETED"])
      );

      const pay = await request(app)
        .post("/api/payments")
        .set(auth(rider.accessToken))
        .set("Idempotency-Key", idemKey())
        .send({ payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });
      expect(pay.status).toBe(201);

      await waitFor(async () => (await types(rider.userId)).includes("PAYMENT_SUCCESS"));
      await waitFor(async () => (await types(driver.userId)).includes("PAYMENT_RECEIVED"));
      // completion + payment emails
      await waitFor(async () => email.sent.length === 2);
      expect(email.sent.map((m) => m.subject).sort()).toEqual(["Payment received", "Trip completed"]);
    });

    it("tells the OTHER party when a ride is cancelled, not the canceller", async () => {
      const admin = await makeAdmin(app);
      const driver = await readyDriver(app, vehicleTypeId, admin.accessToken);
      const rider = await registerUser(app, ["RIDER"]);
      const rideRes = await request(app)
        .post("/api/rides/request")
        .set(auth(rider.accessToken))
        .send({
          pickup: { lat: 12.9716, lng: 77.5946, address: "MG Road" },
          dropoff: { lat: 12.935, lng: 77.6245, address: "Koramangala" },
          vehicleTypeId,
          idempotencyKey: idemKey(),
        });
      const rideId = rideRes.body.data.ride.id;
      await request(app).post(`/api/rides/${rideId}/accept`).set(auth(driver.accessToken));

      const cancel = await request(app).post(`/api/rides/${rideId}/cancel`).set(auth(rider.accessToken)).send({ reason: "changed my mind" });
      expect(cancel.status).toBe(200);

      await waitFor(async () => (await types(driver.userId)).includes("RIDE_CANCELLED"));
      await waitFor(async () => (await types(rider.userId)).includes("RIDE_ASSIGNED")); // let the rider's queue drain
      expect(await types(rider.userId)).not.toContain("RIDE_CANCELLED");
    });

    it("garage booking: owner hears about the request, customer about progress, ready emails the amount due", async () => {
      const owner = await registerGarageOwner(app);
      const g = await createGarage(app, owner);
      const customer = await registerUser(app, ["RIDER"]);
      const created = await request(app).post("/api/bookings").set(auth(customer.accessToken)).send({ garageId: g.garageId, idempotencyKey: bookingKey() });
      const bookingId = created.body.data.booking.id;

      await waitFor(async () => (await types(owner.userId)).includes("BOOKING_REQUESTED"));

      await advanceBooking(app, owner, bookingId, g.mechanicIds[0], "ready");
      await waitFor(async () => (await types(customer.userId)).includes("BOOKING_READY"));
      expect(await types(customer.userId)).toEqual(expect.arrayContaining(["BOOKING_ACCEPTED", "MECHANIC_ASSIGNED", "VEHICLE_RECEIVED", "BOOKING_READY"]));
      await waitFor(async () => email.sent.length === 1);
      expect(email.sent[0].text).toContain("INR 1001.00"); // 500 labour + 2 x 250.50 parts

      await request(app).post("/api/payments").set(auth(customer.accessToken)).set("Idempotency-Key", idemKey())
        .send({ payableType: "GARAGE_SERVICE", payableId: bookingId, paymentMethodToken: "tok_mock_success" });
      await waitFor(async () => (await types(owner.userId)).includes("BOOKING_PAID"));
      await waitFor(async () => (await types(customer.userId)).includes("PAYMENT_SUCCESS"));
    });
  });
});

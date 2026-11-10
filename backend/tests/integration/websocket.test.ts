import http from "http";
import { AddressInfo } from "net";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { createApp } from "../../src/app";
import { createSocketServer } from "../../src/websocket";
import { setIO } from "../../src/websocket/io";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";

/**
 * Unlike every other integration test file (which exercises the REST
 * layer alone via supertest against `createApp()`), this file boots a
 * REAL, listening HTTP server with a REAL Socket.IO server attached -
 * because the entire point of Phase 10 is behavior that only exists
 * once a live WebSocket connection is involved (room broadcast,
 * handshake auth, live location push). Testing this by mocking the
 * socket layer would prove nothing about whether it actually works.
 */

const app = createApp();
const httpServer = http.createServer(app);
let baseUrl: string;
let vehicleTypeId: string;

function connectClient(token: string): ClientSocket {
  return ioClient(baseUrl, { auth: { token }, transports: ["websocket"], forceNew: true });
}

function waitForEvent<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function resetTables() {
  await pool.query(
    `TRUNCATE ride_fares, rides, vehicle_driver_assignments, vehicles, drivers, riders, refresh_tokens, users RESTART IDENTITY CASCADE`
  );
  await redis.flushdb();
}

async function ensureVehicleType() {
  const { rows } = await pool.query(
    `INSERT INTO vehicle_types (code, display_name, base_fare, per_km_rate, per_min_rate)
     VALUES ('WS_TEST_SEDAN', 'Test Sedan', 50, 13, 1.5)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`
  );
  vehicleTypeId = rows[0].id;
}

async function registerAndLogin(roles: string[]) {
  const email = `ws-${Date.now()}-${Math.random().toString(36).slice(2)}@ridex.dev`;
  const res = await request(app).post("/api/auth/register").send({
    email,
    password: "Passw0rd123",
    fullName: "WS Test User",
    roles,
  });
  return { userId: res.body.data.user.id, accessToken: res.body.data.accessToken, email };
}

async function promoteToAdmin(userId: string) {
  await pool.query(`UPDATE users SET roles = array_append(roles, 'ADMIN') WHERE id = $1`, [userId]);
}

async function readyDriver() {
  const owner = await registerAndLogin(["VEHICLE_OWNER"]);
  const vehicleRes = await request(app)
    .post("/api/vehicles")
    .set("Authorization", `Bearer ${owner.accessToken}`)
    .send({
      vehicleTypeId,
      registrationNumber: `KA-WS-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      brand: "Toyota",
      model: "Corolla",
      year: 2022,
    });
  const vehicleId = vehicleRes.body.data.vehicle.id;

  const driver = await registerAndLogin(["DRIVER"]);
  await request(app)
    .post("/api/drivers/onboard")
    .set("Authorization", `Bearer ${driver.accessToken}`)
    .send({ licenseNumber: `DL-WS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, licenseExpiry: "2030-06-30" });

  const admin = await registerAndLogin(["RIDER"]);
  await promoteToAdmin(admin.userId);
  const adminLogin = await request(app).post("/api/auth/login").send({ email: admin.email, password: "Passw0rd123" });
  await request(app)
    .patch(`/api/drivers/${driver.userId}/verification`)
    .set("Authorization", `Bearer ${adminLogin.body.data.accessToken}`)
    .send({ status: "VERIFIED" });

  await request(app)
    .post(`/api/vehicles/${vehicleId}/assign-driver`)
    .set("Authorization", `Bearer ${owner.accessToken}`)
    .send({ driverId: driver.userId, commissionPercent: 20, ownerSharePercent: 80 });

  await request(app).post("/api/drivers/online").set("Authorization", `Bearer ${driver.accessToken}`);

  return { driver, vehicleId };
}

describe("WebSocket real-time layer (live server, real socket.io-client)", () => {
  beforeAll(async () => {
    const io = createSocketServer(httpServer);
    setIO(io);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;
    await ensureVehicleType();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closeTestDb();
    redis.disconnect();
  });

  beforeEach(resetTables);

  describe("Authentication", () => {
    it("rejects a connection with no token", async () => {
      const client = connectClient("");
      const err = await new Promise<Error>((resolve) => {
        client.on("connect_error", resolve);
      });
      expect(err.message).toMatch(/authentication required/i);
      client.close();
    });

    it("rejects a connection with an invalid token", async () => {
      const client = ioClient(baseUrl, { auth: { token: "not-a-real-token" }, transports: ["websocket"], forceNew: true });
      const err = await new Promise<Error>((resolve) => {
        client.on("connect_error", resolve);
      });
      expect(err.message).toMatch(/authentication failed/i);
      client.close();
    });

    it("accepts a connection with a valid access token", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const client = connectClient(rider.accessToken);
      await new Promise<void>((resolve) => client.on("connect", () => resolve()));
      expect(client.connected).toBe(true);
      client.close();
    });
  });

  describe("ride:join authorization", () => {
    it("allows the ride's rider to join its room", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app)
        .post("/api/rides/request")
        .set("Authorization", `Bearer ${rider.accessToken}`)
        .send({
          pickup: { lat: 12.9716, lng: 77.5946, address: "MG Road" },
          dropoff: { lat: 12.935, lng: 77.6245, address: "Koramangala" },
          vehicleTypeId,
          idempotencyKey: `ws-idem-${Date.now()}`,
        });
      const rideId = rideRes.body.data.ride.id;

      const client = connectClient(rider.accessToken);
      await new Promise<void>((resolve) => client.on("connect", () => resolve()));

      client.emit("ride:join", { rideId });
      const joined = await waitForEvent<{ rideId: string }>(client, "ride:joined");
      expect(joined.rideId).toBe(rideId);

      client.close();
    });

    it("rejects a stranger trying to join a ride's room", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app)
        .post("/api/rides/request")
        .set("Authorization", `Bearer ${rider.accessToken}`)
        .send({
          pickup: { lat: 12.9716, lng: 77.5946, address: "MG Road" },
          dropoff: { lat: 12.935, lng: 77.6245, address: "Koramangala" },
          vehicleTypeId,
          idempotencyKey: `ws-idem-stranger-${Date.now()}`,
        });
      const rideId = rideRes.body.data.ride.id;

      const stranger = await registerAndLogin(["RIDER"]);
      const client = connectClient(stranger.accessToken);
      await new Promise<void>((resolve) => client.on("connect", () => resolve()));

      client.emit("ride:join", { rideId });
      const err = await waitForEvent<{ code: string; message: string }>(client, "error");
      expect(err.code).toBe("NOT_FOUND");

      client.close();
    });
  });

  describe("Live ride event broadcast", () => {
    it("pushes ride:accepted to the rider in real time when a driver accepts via REST", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app)
        .post("/api/rides/request")
        .set("Authorization", `Bearer ${rider.accessToken}`)
        .send({
          pickup: { lat: 12.9716, lng: 77.5946, address: "MG Road" },
          dropoff: { lat: 12.935, lng: 77.6245, address: "Koramangala" },
          vehicleTypeId,
          idempotencyKey: `ws-idem-accept-${Date.now()}`,
        });
      const rideId = rideRes.body.data.ride.id;

      const riderClient = connectClient(rider.accessToken);
      await new Promise<void>((resolve) => riderClient.on("connect", () => resolve()));
      riderClient.emit("ride:join", { rideId });
      await waitForEvent(riderClient, "ride:joined");

      const acceptedPromise = waitForEvent<{ id: string; status: string; driverId: string }>(
        riderClient,
        "ride:accepted"
      );

      const { driver } = await readyDriver();
      await request(app).post(`/api/rides/${rideId}/accept`).set("Authorization", `Bearer ${driver.accessToken}`);

      const payload = await acceptedPromise;
      expect(payload.id).toBe(rideId);
      expect(payload.status).toBe("DRIVER_ASSIGNED");
      expect(payload.driverId).toBe(driver.userId);

      riderClient.close();
    });

    it("pushes ride:completed to both rider and driver when the trip completes", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app)
        .post("/api/rides/request")
        .set("Authorization", `Bearer ${rider.accessToken}`)
        .send({
          pickup: { lat: 12.9716, lng: 77.5946, address: "MG Road" },
          dropoff: { lat: 12.935, lng: 77.6245, address: "Koramangala" },
          vehicleTypeId,
          idempotencyKey: `ws-idem-complete-${Date.now()}`,
        });
      const rideId = rideRes.body.data.ride.id;
      const { driver } = await readyDriver();
      await request(app).post(`/api/rides/${rideId}/accept`).set("Authorization", `Bearer ${driver.accessToken}`);
      await request(app).post(`/api/rides/${rideId}/arriving`).set("Authorization", `Bearer ${driver.accessToken}`);
      await request(app).post(`/api/rides/${rideId}/arrived`).set("Authorization", `Bearer ${driver.accessToken}`);
      await request(app).post(`/api/rides/${rideId}/start`).set("Authorization", `Bearer ${driver.accessToken}`);

      const riderClient = connectClient(rider.accessToken);
      const driverClient = connectClient(driver.accessToken);
      await Promise.all([
        new Promise<void>((resolve) => riderClient.on("connect", () => resolve())),
        new Promise<void>((resolve) => driverClient.on("connect", () => resolve())),
      ]);
      // Both join via their PERSONAL room automatically on connect (no
      // explicit ride:join needed) - proving broadcastRideEvent's
      // per-user-room emit reaches clients who never subscribed to the
      // ride room specifically.
      const riderPromise = waitForEvent<{ status: string }>(riderClient, "ride:completed");
      const driverPromise = waitForEvent<{ status: string }>(driverClient, "ride:completed");

      await request(app).post(`/api/rides/${rideId}/complete`).set("Authorization", `Bearer ${driver.accessToken}`);

      const [riderPayload, driverPayload] = await Promise.all([riderPromise, driverPromise]);
      expect(riderPayload.status).toBe("TRIP_COMPLETED");
      expect(driverPayload.status).toBe("TRIP_COMPLETED");

      riderClient.close();
      driverClient.close();
    });
  });

  describe("Live driver location broadcast", () => {
    it("pushes driver:location:update to a rider subscribed to the ride room", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app)
        .post("/api/rides/request")
        .set("Authorization", `Bearer ${rider.accessToken}`)
        .send({
          pickup: { lat: 12.9716, lng: 77.5946, address: "MG Road" },
          dropoff: { lat: 12.935, lng: 77.6245, address: "Koramangala" },
          vehicleTypeId,
          idempotencyKey: `ws-idem-location-${Date.now()}`,
        });
      const rideId = rideRes.body.data.ride.id;
      const { driver } = await readyDriver();
      await request(app).post(`/api/rides/${rideId}/accept`).set("Authorization", `Bearer ${driver.accessToken}`);

      const riderClient = connectClient(rider.accessToken);
      const driverClient = connectClient(driver.accessToken);
      await Promise.all([
        new Promise<void>((resolve) => riderClient.on("connect", () => resolve())),
        new Promise<void>((resolve) => driverClient.on("connect", () => resolve())),
      ]);
      riderClient.emit("ride:join", { rideId });
      await waitForEvent(riderClient, "ride:joined");

      const locationPromise = waitForEvent<{ driverId: string; lat: number; lng: number }>(
        riderClient,
        "driver:location:update"
      );

      driverClient.emit("driver:location:update", { lat: 12.973, lng: 77.596, heading: 45, speedKmh: 30 });

      const payload = await locationPromise;
      expect(payload.driverId).toBe(driver.userId);
      expect(payload.lat).toBeCloseTo(12.973, 3);

      riderClient.close();
      driverClient.close();
    });

    it("rejects a non-driver trying to broadcast location over the socket", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const client = connectClient(rider.accessToken);
      await new Promise<void>((resolve) => client.on("connect", () => resolve()));

      const errorPromise = waitForEvent<{ code: string }>(client, "error");
      client.emit("driver:location:update", { lat: 12.97, lng: 77.59 });

      const err = await errorPromise;
      expect(err.code).toBe("FORBIDDEN");

      client.close();
    });
  });

  describe("Live rider location relay", () => {
    async function rideWithDriver() {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send({
        pickup: { lat: 12.9716, lng: 77.5946, address: "MG Road" }, dropoff: { lat: 12.935, lng: 77.6245, address: "Koramangala" },
        vehicleTypeId, idempotencyKey: `ws-idem-riderloc-${Date.now()}-${Math.random()}`,
      });
      const rideId = rideRes.body.data.ride.id;
      const { driver } = await readyDriver();
      await request(app).post(`/api/rides/${rideId}/accept`).set("Authorization", `Bearer ${driver.accessToken}`);
      return { rider, driver, rideId };
    }

    it("relays the rider's position to the driver in the ride room", async () => {
      const { rider, driver, rideId } = await rideWithDriver();
      const riderClient = connectClient(rider.accessToken);
      const driverClient = connectClient(driver.accessToken);
      await Promise.all([riderClient, driverClient].map((c) => new Promise<void>((r) => c.on("connect", () => r()))));
      driverClient.emit("ride:join", { rideId });
      await waitForEvent(driverClient, "ride:joined");

      const got = waitForEvent<{ rideId: string; lat: number; lng: number; accuracy: number | null }>(driverClient, "rider:location:update");
      riderClient.emit("rider:location:update", { lat: 12.9719, lng: 77.5951, accuracy: 12 });
      const p = await got;
      expect(p.rideId).toBe(rideId);
      expect(p.lat).toBeCloseTo(12.9719, 4);
      expect(p.accuracy).toBe(12);
      riderClient.close(); driverClient.close();
    });

    it("rejects non-riders and impossible coordinates", async () => {
      const { rider, driver } = await rideWithDriver();
      const driverClient = connectClient(driver.accessToken);
      const riderClient = connectClient(rider.accessToken);
      await Promise.all([riderClient, driverClient].map((c) => new Promise<void>((r) => c.on("connect", () => r()))));

      const e1 = waitForEvent<{ code: string }>(driverClient, "error");
      driverClient.emit("rider:location:update", { lat: 12.9, lng: 77.5 });
      expect((await e1).code).toBe("FORBIDDEN");

      const e2 = waitForEvent<{ code: string }>(riderClient, "error");
      riderClient.emit("rider:location:update", { lat: 999, lng: 77.5 });
      expect((await e2).code).toBeTruthy();
      riderClient.close(); driverClient.close();
    });
  });

  describe("driver:online / driver:offline over the socket", () => {
    it("toggles online status via socket event and acknowledges with the updated profile", async () => {
      const { driver } = await readyDriver();
      const client = connectClient(driver.accessToken);
      await new Promise<void>((resolve) => client.on("connect", () => resolve()));

      const offlinePromise = waitForEvent<{ isOnline: boolean }>(client, "driver:offline");
      client.emit("driver:offline");
      const offlineResult = await offlinePromise;
      expect(offlineResult.isOnline).toBe(false);

      const onlinePromise = waitForEvent<{ isOnline: boolean }>(client, "driver:online");
      client.emit("driver:online");
      const onlineResult = await onlinePromise;
      expect(onlineResult.isOnline).toBe(true);

      client.close();
    });
  });
});

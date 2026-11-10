import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { closeTestDb } from "./testUtils";
import { redis } from "../../src/config/redis";

const app = createApp();
let vehicleTypeId: string;

async function resetTables() {
  await pool.query(
    `TRUNCATE ride_fares, rides, vehicle_driver_assignments, vehicles, drivers, riders, refresh_tokens, users RESTART IDENTITY CASCADE`
  );
}

async function ensureVehicleType() {
  const { rows } = await pool.query(
    `INSERT INTO vehicle_types (code, display_name, base_fare, per_km_rate, per_min_rate)
     VALUES ('RIDE_TEST_SEDAN', 'Test Sedan', 50, 13, 1.5)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`
  );
  vehicleTypeId = rows[0].id;
}

async function registerAndLogin(roles: string[]) {
  const email = `ride-${Date.now()}-${Math.random().toString(36).slice(2)}@ridex.dev`;
  const res = await request(app).post("/api/auth/register").send({
    email,
    password: "Passw0rd123",
    fullName: "Ride Test User",
    roles,
  });
  return { userId: res.body.data.user.id, accessToken: res.body.data.accessToken, email };
}

async function promoteToAdmin(userId: string) {
  await pool.query(`UPDATE users SET roles = array_append(roles, 'ADMIN') WHERE id = $1`, [userId]);
}

async function readyDriver(owner?: { userId: string; accessToken: string }) {
  const ownerAccount = owner ?? (await registerAndLogin(["VEHICLE_OWNER"]));
  const vehicleRes = await request(app)
    .post("/api/vehicles")
    .set("Authorization", `Bearer ${ownerAccount.accessToken}`)
    .send({
      vehicleTypeId,
      registrationNumber: `KA-RIDE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      brand: "Toyota",
      model: "Corolla",
      year: 2022,
    });
  const vehicleId = vehicleRes.body.data.vehicle.id;

  const driver = await registerAndLogin(["DRIVER"]);
  await request(app)
    .post("/api/drivers/onboard")
    .set("Authorization", `Bearer ${driver.accessToken}`)
    .send({ licenseNumber: `DL-RIDE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, licenseExpiry: "2030-06-30" });

  const admin = await registerAndLogin(["RIDER"]);
  await promoteToAdmin(admin.userId);
  const adminLogin = await request(app).post("/api/auth/login").send({ email: admin.email, password: "Passw0rd123" });
  await request(app)
    .patch(`/api/drivers/${driver.userId}/verification`)
    .set("Authorization", `Bearer ${adminLogin.body.data.accessToken}`)
    .send({ status: "VERIFIED" });

  await request(app)
    .post(`/api/vehicles/${vehicleId}/assign-driver`)
    .set("Authorization", `Bearer ${ownerAccount.accessToken}`)
    .send({ driverId: driver.userId, commissionPercent: 20, ownerSharePercent: 80 });

  await request(app).post("/api/drivers/online").set("Authorization", `Bearer ${driver.accessToken}`);

  return { driver, vehicleId, owner: ownerAccount };
}

function ridePayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    pickup: { lat: 12.9716, lng: 77.5946, address: "MG Road, Bangalore" },
    dropoff: { lat: 12.935, lng: 77.6245, address: "Koramangala, Bangalore" },
    vehicleTypeId,
    idempotencyKey: `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  };
}

describe("Rides module (live DB)", () => {
  beforeAll(ensureVehicleType);
  beforeEach(resetTables);
  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  describe("Fare estimate", () => {
    it("returns a distance, duration, and fare breakdown", async () => {
      const rider = await registerAndLogin(["RIDER"]);

      const res = await request(app)
        .post("/api/rides/estimate")
        .set("Authorization", `Bearer ${rider.accessToken}`)
        .send({
          pickup: { lat: 12.9716, lng: 77.5946 },
          dropoff: { lat: 12.935, lng: 77.6245 },
          vehicleTypeId,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.distanceMeters).toBeGreaterThan(0);
      expect(res.body.data.fare.totalFare).toBeGreaterThan(0);
    });

    it("rejects an unknown vehicle type", async () => {
      const rider = await registerAndLogin(["RIDER"]);

      const res = await request(app)
        .post("/api/rides/estimate")
        .set("Authorization", `Bearer ${rider.accessToken}`)
        .send({
          pickup: { lat: 12.9716, lng: 77.5946 },
          dropoff: { lat: 12.935, lng: 77.6245 },
          vehicleTypeId: "00000000-0000-0000-0000-000000000000",
        });

      expect(res.status).toBe(400);
    });
  });

  describe("Request + idempotency", () => {
    it("creates a ride in SEARCHING_DRIVER status", async () => {
      const rider = await registerAndLogin(["RIDER"]);

      const res = await request(app)
        .post("/api/rides/request")
        .set("Authorization", `Bearer ${rider.accessToken}`)
        .send(ridePayload());

      expect(res.status).toBe(201);
      expect(res.body.data.ride.status).toBe("SEARCHING_DRIVER");
    });

    it("returns the SAME ride for a repeated idempotency key instead of creating a duplicate", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const payload = ridePayload();

      const first = await request(app)
        .post("/api/rides/request")
        .set("Authorization", `Bearer ${rider.accessToken}`)
        .send(payload);

      const second = await request(app)
        .post("/api/rides/request")
        .set("Authorization", `Bearer ${rider.accessToken}`)
        .send(payload);

      expect(second.status).toBe(201);
      expect(second.body.data.ride.id).toBe(first.body.data.ride.id);

      const { rows } = await pool.query(`SELECT count(*) FROM rides WHERE rider_id = $1`, [rider.userId]);
      expect(Number(rows[0].count)).toBe(1);
    });

    it("rejects requesting a second ride while one is already active", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      await request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send(ridePayload());

      const res = await request(app)
        .post("/api/rides/request")
        .set("Authorization", `Bearer ${rider.accessToken}`)
        .send(ridePayload());

      expect(res.status).toBe(409);
    });
  });

  describe("Driver acceptance", () => {
    it("rejects acceptance from a driver with no assigned vehicle", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send(ridePayload());

      const driver = await registerAndLogin(["DRIVER"]);
      await request(app)
        .post("/api/drivers/onboard")
        .set("Authorization", `Bearer ${driver.accessToken}`)
        .send({ licenseNumber: `DL-NOCAR-${Date.now()}`, licenseExpiry: "2030-06-30" });

      // Verify the driver but deliberately skip vehicle assignment, so
      // this test isolates the "no vehicle" check specifically - without
      // verification, the earlier verification-status check would fire
      // first and this test would (incorrectly) prove nothing about the
      // vehicle-assignment check at all.
      const admin = await registerAndLogin(["RIDER"]);
      await promoteToAdmin(admin.userId);
      const adminLogin = await request(app).post("/api/auth/login").send({ email: admin.email, password: "Passw0rd123" });
      await request(app)
        .patch(`/api/drivers/${driver.userId}/verification`)
        .set("Authorization", `Bearer ${adminLogin.body.data.accessToken}`)
        .send({ status: "VERIFIED" });
      await request(app).post("/api/drivers/online").set("Authorization", `Bearer ${driver.accessToken}`);

      const res = await request(app)
        .post(`/api/rides/${rideRes.body.data.ride.id}/accept`)
        .set("Authorization", `Bearer ${driver.accessToken}`);

      expect(res.status).toBe(400);
    });

    it("rejects acceptance from an offline driver", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send(ridePayload());

      const { driver } = await readyDriver();
      await request(app).post("/api/drivers/offline").set("Authorization", `Bearer ${driver.accessToken}`);

      const res = await request(app)
        .post(`/api/rides/${rideRes.body.data.ride.id}/accept`)
        .set("Authorization", `Bearer ${driver.accessToken}`);

      expect(res.status).toBe(403);
    });

    it("accepts a ride and puts the vehicle IN_RIDE_SERVICE", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send(ridePayload());
      const { driver, vehicleId } = await readyDriver();

      const res = await request(app)
        .post(`/api/rides/${rideRes.body.data.ride.id}/accept`)
        .set("Authorization", `Bearer ${driver.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.ride.status).toBe("DRIVER_ASSIGNED");
      expect(res.body.data.ride.driverId).toBe(driver.userId);

      const vehicleRow = await pool.query(`SELECT status FROM vehicles WHERE id = $1`, [vehicleId]);
      expect(vehicleRow.rows[0].status).toBe("IN_RIDE_SERVICE");
    });

    it("rejects accepting a ride that's already been accepted", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send(ridePayload());
      const { driver: driverA } = await readyDriver();
      const { driver: driverB } = await readyDriver();

      await request(app).post(`/api/rides/${rideRes.body.data.ride.id}/accept`).set("Authorization", `Bearer ${driverA.accessToken}`);
      const res = await request(app)
        .post(`/api/rides/${rideRes.body.data.ride.id}/accept`)
        .set("Authorization", `Bearer ${driverB.accessToken}`);

      expect(res.status).toBe(409);
    });
  });

  describe("Full happy-path lifecycle", () => {
    it("walks REQUESTED through TRIP_COMPLETED, freeing the vehicle and updating ride counts", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send(ridePayload());
      const rideId = rideRes.body.data.ride.id;
      const { driver, vehicleId } = await readyDriver();

      await request(app).post(`/api/rides/${rideId}/accept`).set("Authorization", `Bearer ${driver.accessToken}`);
      const arriving = await request(app).post(`/api/rides/${rideId}/arriving`).set("Authorization", `Bearer ${driver.accessToken}`);
      expect(arriving.body.data.ride.status).toBe("DRIVER_ARRIVING");

      const arrived = await request(app).post(`/api/rides/${rideId}/arrived`).set("Authorization", `Bearer ${driver.accessToken}`);
      expect(arrived.body.data.ride.status).toBe("DRIVER_ARRIVED");

      const started = await request(app).post(`/api/rides/${rideId}/start`).set("Authorization", `Bearer ${driver.accessToken}`);
      expect(started.body.data.ride.status).toBe("TRIP_STARTED");

      const completed = await request(app).post(`/api/rides/${rideId}/complete`).set("Authorization", `Bearer ${driver.accessToken}`);
      expect(completed.status).toBe(200);
      expect(completed.body.data.ride.status).toBe("TRIP_COMPLETED");

      const vehicleRow = await pool.query(`SELECT status FROM vehicles WHERE id = $1`, [vehicleId]);
      expect(vehicleRow.rows[0].status).toBe("AVAILABLE");

      const fareRow = await pool.query(`SELECT total_fare FROM ride_fares WHERE ride_id = $1`, [rideId]);
      expect(Number(fareRow.rows[0].total_fare)).toBeGreaterThan(0);

      const driverRow = await pool.query(`SELECT total_rides FROM drivers WHERE user_id = $1`, [driver.userId]);
      expect(driverRow.rows[0].total_rides).toBe(1);
      const riderRow = await pool.query(`SELECT total_rides FROM riders WHERE user_id = $1`, [rider.userId]);
      expect(riderRow.rows[0].total_rides).toBe(1);
    });

    it("rejects skipping a state (e.g. accept then immediately complete)", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send(ridePayload());
      const { driver } = await readyDriver();
      await request(app).post(`/api/rides/${rideRes.body.data.ride.id}/accept`).set("Authorization", `Bearer ${driver.accessToken}`);

      const res = await request(app)
        .post(`/api/rides/${rideRes.body.data.ride.id}/complete`)
        .set("Authorization", `Bearer ${driver.accessToken}`);

      expect(res.status).toBe(400);
    });
  });

  describe("Cancellation", () => {
    it("allows the rider to cancel a SEARCHING_DRIVER ride", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send(ridePayload());

      const res = await request(app)
        .post(`/api/rides/${rideRes.body.data.ride.id}/cancel`)
        .set("Authorization", `Bearer ${rider.accessToken}`)
        .send({ reason: "Changed my mind" });

      expect(res.status).toBe(200);
      expect(res.body.data.ride.status).toBe("CANCELLED_BY_RIDER");
    });

    it("frees the vehicle back to AVAILABLE when a post-acceptance ride is cancelled", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send(ridePayload());
      const { driver, vehicleId } = await readyDriver();
      await request(app).post(`/api/rides/${rideRes.body.data.ride.id}/accept`).set("Authorization", `Bearer ${driver.accessToken}`);

      const res = await request(app)
        .post(`/api/rides/${rideRes.body.data.ride.id}/cancel`)
        .set("Authorization", `Bearer ${driver.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.ride.status).toBe("CANCELLED_BY_DRIVER");

      const vehicleRow = await pool.query(`SELECT status FROM vehicles WHERE id = $1`, [vehicleId]);
      expect(vehicleRow.rows[0].status).toBe("AVAILABLE");
    });

    it("rejects cancellation once the trip has started", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send(ridePayload());
      const rideId = rideRes.body.data.ride.id;
      const { driver } = await readyDriver();
      await request(app).post(`/api/rides/${rideId}/accept`).set("Authorization", `Bearer ${driver.accessToken}`);
      await request(app).post(`/api/rides/${rideId}/arriving`).set("Authorization", `Bearer ${driver.accessToken}`);
      await request(app).post(`/api/rides/${rideId}/arrived`).set("Authorization", `Bearer ${driver.accessToken}`);
      await request(app).post(`/api/rides/${rideId}/start`).set("Authorization", `Bearer ${driver.accessToken}`);

      const res = await request(app)
        .post(`/api/rides/${rideId}/cancel`)
        .set("Authorization", `Bearer ${rider.accessToken}`);

      expect(res.status).toBe(400);
    });

    it("rejects cancellation from someone who isn't a party to the ride", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send(ridePayload());

      const stranger = await registerAndLogin(["RIDER"]);
      const res = await request(app)
        .post(`/api/rides/${rideRes.body.data.ride.id}/cancel`)
        .set("Authorization", `Bearer ${stranger.accessToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe("Ownership / visibility", () => {
    it("lets the rider and the assigned driver both view the ride, but not a stranger", async () => {
      const rider = await registerAndLogin(["RIDER"]);
      const rideRes = await request(app).post("/api/rides/request").set("Authorization", `Bearer ${rider.accessToken}`).send(ridePayload());
      const { driver } = await readyDriver();
      await request(app).post(`/api/rides/${rideRes.body.data.ride.id}/accept`).set("Authorization", `Bearer ${driver.accessToken}`);

      const asRider = await request(app).get(`/api/rides/${rideRes.body.data.ride.id}`).set("Authorization", `Bearer ${rider.accessToken}`);
      const asDriver = await request(app).get(`/api/rides/${rideRes.body.data.ride.id}`).set("Authorization", `Bearer ${driver.accessToken}`);
      const stranger = await registerAndLogin(["RIDER"]);
      const asStranger = await request(app).get(`/api/rides/${rideRes.body.data.ride.id}`).set("Authorization", `Bearer ${stranger.accessToken}`);

      expect(asRider.status).toBe(200);
      expect(asDriver.status).toBe(200);
      expect(asStranger.status).toBe(404);
    });

    it("ride history returns only the requesting rider's own rides", async () => {
      const riderA = await registerAndLogin(["RIDER"]);
      const riderB = await registerAndLogin(["RIDER"]);
      await request(app).post("/api/rides/request").set("Authorization", `Bearer ${riderA.accessToken}`).send(ridePayload());
      await request(app).post("/api/rides/request").set("Authorization", `Bearer ${riderB.accessToken}`).send(ridePayload());

      const res = await request(app).get("/api/rides/history").set("Authorization", `Bearer ${riderA.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.rides).toHaveLength(1);
      expect(res.body.data.rides[0].riderId).toBe(riderA.userId);
    });
  });
});

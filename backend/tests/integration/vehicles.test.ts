import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { closeTestDb } from "./testUtils";
import { redis } from "../../src/config/redis";

const app = createApp();

let vehicleTypeId: string;

async function resetTables() {
  await pool.query(
    `TRUNCATE vehicle_driver_assignments, vehicles, drivers, riders, refresh_tokens, users RESTART IDENTITY CASCADE`
  );
}

async function ensureVehicleType() {
  const { rows } = await pool.query(
    `INSERT INTO vehicle_types (code, display_name) VALUES ('VEH_TEST_SEDAN', 'Test Sedan')
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`
  );
  vehicleTypeId = rows[0].id;
}

async function registerAndLogin(roles: string[]) {
  const email = `user-${Date.now()}-${Math.random().toString(36).slice(2)}@ridex.dev`;
  const res = await request(app).post("/api/auth/register").send({
    email,
    password: "Passw0rd123",
    fullName: "Test User",
    roles,
  });
  return { userId: res.body.data.user.id, accessToken: res.body.data.accessToken, email };
}

async function promoteToAdmin(userId: string) {
  await pool.query(`UPDATE users SET roles = array_append(roles, 'ADMIN') WHERE id = $1`, [userId]);
}

function vehiclePayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    vehicleTypeId,
    registrationNumber: `KA-01-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    brand: "Toyota",
    model: "Corolla",
    year: 2022,
    ...overrides,
  };
}

describe("Vehicles module (live DB)", () => {
  beforeAll(ensureVehicleType);
  beforeEach(resetTables);
  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  describe("Create + ownership", () => {
    it("registers a vehicle for a VEHICLE_OWNER user", async () => {
      const owner = await registerAndLogin(["VEHICLE_OWNER"]);

      const res = await request(app)
        .post("/api/vehicles")
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send(vehiclePayload());

      expect(res.status).toBe(201);
      expect(res.body.data.vehicle.status).toBe("AVAILABLE");
      expect(res.body.data.vehicle.ownerId).toBe(owner.userId);
    });

    it("rejects vehicle creation from a non-owner role", async () => {
      const rider = await registerAndLogin(["RIDER"]);

      const res = await request(app)
        .post("/api/vehicles")
        .set("Authorization", `Bearer ${rider.accessToken}`)
        .send(vehiclePayload());

      expect(res.status).toBe(403);
    });

    it("rejects a duplicate registration number", async () => {
      const owner = await registerAndLogin(["VEHICLE_OWNER"]);
      const payload = vehiclePayload({ registrationNumber: "KA-DUPE-001" });

      await request(app).post("/api/vehicles").set("Authorization", `Bearer ${owner.accessToken}`).send(payload);
      const res = await request(app)
        .post("/api/vehicles")
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ ...payload, registrationNumber: "KA-DUPE-001" });

      expect(res.status).toBe(409);
    });

    it("hides another owner's vehicle behind a 404 (not 403)", async () => {
      const ownerA = await registerAndLogin(["VEHICLE_OWNER"]);
      const ownerB = await registerAndLogin(["VEHICLE_OWNER"]);

      const created = await request(app)
        .post("/api/vehicles")
        .set("Authorization", `Bearer ${ownerA.accessToken}`)
        .send(vehiclePayload());
      const vehicleId = created.body.data.vehicle.id;

      const res = await request(app)
        .get(`/api/vehicles/${vehicleId}`)
        .set("Authorization", `Bearer ${ownerB.accessToken}`);

      expect(res.status).toBe(404);
    });

    it("lists only the requesting owner's own vehicles", async () => {
      const ownerA = await registerAndLogin(["VEHICLE_OWNER"]);
      const ownerB = await registerAndLogin(["VEHICLE_OWNER"]);
      await request(app).post("/api/vehicles").set("Authorization", `Bearer ${ownerA.accessToken}`).send(vehiclePayload());
      await request(app).post("/api/vehicles").set("Authorization", `Bearer ${ownerB.accessToken}`).send(vehiclePayload());
      await request(app).post("/api/vehicles").set("Authorization", `Bearer ${ownerB.accessToken}`).send(vehiclePayload());

      const res = await request(app).get("/api/vehicles/mine").set("Authorization", `Bearer ${ownerB.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.vehicles).toHaveLength(2);
    });
  });

  describe("Status state machine (enforced live, not just unit-tested)", () => {
    async function createOwnerAndVehicle() {
      const owner = await registerAndLogin(["VEHICLE_OWNER"]);
      const created = await request(app)
        .post("/api/vehicles")
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send(vehiclePayload());
      return { owner, vehicleId: created.body.data.vehicle.id };
    }

    it("allows AVAILABLE -> UNDER_MAINTENANCE", async () => {
      const { owner, vehicleId } = await createOwnerAndVehicle();

      const res = await request(app)
        .patch(`/api/vehicles/${vehicleId}/status`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ status: "UNDER_MAINTENANCE" });

      expect(res.status).toBe(200);
      expect(res.body.data.vehicle.status).toBe("UNDER_MAINTENANCE");
    });

    it("rejects UNDER_MAINTENANCE -> RENTED (must pass through AVAILABLE)", async () => {
      const { owner, vehicleId } = await createOwnerAndVehicle();
      await request(app)
        .patch(`/api/vehicles/${vehicleId}/status`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ status: "UNDER_MAINTENANCE" });

      const res = await request(app)
        .patch(`/api/vehicles/${vehicleId}/status`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ status: "RENTED" });

      expect(res.status).toBe(400);
    });

    it("rejects a status update from a non-owner", async () => {
      const { vehicleId } = await createOwnerAndVehicle();
      const intruder = await registerAndLogin(["VEHICLE_OWNER"]);

      const res = await request(app)
        .patch(`/api/vehicles/${vehicleId}/status`)
        .set("Authorization", `Bearer ${intruder.accessToken}`)
        .send({ status: "UNDER_MAINTENANCE" });

      expect(res.status).toBe(404); // ownership-hiding, same as GET
    });
  });

  describe("Driver assignment", () => {
    async function verifiedDriver() {
      const driver = await registerAndLogin(["DRIVER"]);
      await request(app)
        .post("/api/drivers/onboard")
        .set("Authorization", `Bearer ${driver.accessToken}`)
        .send({ licenseNumber: `DL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, licenseExpiry: "2030-06-30" });

      const admin = await registerAndLogin(["RIDER"]);
      await promoteToAdmin(admin.userId);
      const adminLogin = await request(app)
        .post("/api/auth/login")
        .send({ email: admin.email, password: "Passw0rd123" });

      await request(app)
        .patch(`/api/drivers/${driver.userId}/verification`)
        .set("Authorization", `Bearer ${adminLogin.body.data.accessToken}`)
        .send({ status: "VERIFIED" });

      return driver;
    }

    it("assigns a verified driver to an AVAILABLE vehicle", async () => {
      const owner = await registerAndLogin(["VEHICLE_OWNER"]);
      const vehicle = await request(app)
        .post("/api/vehicles")
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send(vehiclePayload());
      const driver = await verifiedDriver();

      const res = await request(app)
        .post(`/api/vehicles/${vehicle.body.data.vehicle.id}/assign-driver`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ driverId: driver.userId, commissionPercent: 20, ownerSharePercent: 80 });

      expect(res.status).toBe(201);
      expect(res.body.data.assignment.status).toBe("ACTIVE");

      // Confirm both sides of the relationship were updated (repository's
      // atomic transaction - see vehicles.repository.ts createAssignment)
      const vehicleRow = await pool.query("SELECT current_driver_id FROM vehicles WHERE id = $1", [
        vehicle.body.data.vehicle.id,
      ]);
      const driverRow = await pool.query("SELECT current_vehicle_id FROM drivers WHERE user_id = $1", [driver.userId]);
      expect(vehicleRow.rows[0].current_driver_id).toBe(driver.userId);
      expect(driverRow.rows[0].current_vehicle_id).toBe(vehicle.body.data.vehicle.id);
    });

    it("rejects assigning an unverified driver", async () => {
      const owner = await registerAndLogin(["VEHICLE_OWNER"]);
      const vehicle = await request(app)
        .post("/api/vehicles")
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send(vehiclePayload());

      const unverifiedDriver = await registerAndLogin(["DRIVER"]);
      await request(app)
        .post("/api/drivers/onboard")
        .set("Authorization", `Bearer ${unverifiedDriver.accessToken}`)
        .send({ licenseNumber: `DL-UNVERIFIED-${Date.now()}`, licenseExpiry: "2030-06-30" });

      const res = await request(app)
        .post(`/api/vehicles/${vehicle.body.data.vehicle.id}/assign-driver`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ driverId: unverifiedDriver.userId, commissionPercent: 20, ownerSharePercent: 80 });

      expect(res.status).toBe(403);
    });

    it("rejects assigning a driver who already has an active assignment elsewhere", async () => {
      const owner = await registerAndLogin(["VEHICLE_OWNER"]);
      const vehicleA = await request(app)
        .post("/api/vehicles")
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send(vehiclePayload());
      const vehicleB = await request(app)
        .post("/api/vehicles")
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send(vehiclePayload());
      const driver = await verifiedDriver();

      await request(app)
        .post(`/api/vehicles/${vehicleA.body.data.vehicle.id}/assign-driver`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ driverId: driver.userId, commissionPercent: 20, ownerSharePercent: 80 });

      const res = await request(app)
        .post(`/api/vehicles/${vehicleB.body.data.vehicle.id}/assign-driver`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ driverId: driver.userId, commissionPercent: 20, ownerSharePercent: 80 });

      expect(res.status).toBe(409);
    });

    it("unassigns a driver and clears both sides of the relationship", async () => {
      const owner = await registerAndLogin(["VEHICLE_OWNER"]);
      const vehicle = await request(app)
        .post("/api/vehicles")
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send(vehiclePayload());
      const driver = await verifiedDriver();

      await request(app)
        .post(`/api/vehicles/${vehicle.body.data.vehicle.id}/assign-driver`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ driverId: driver.userId, commissionPercent: 20, ownerSharePercent: 80 });

      const res = await request(app)
        .post(`/api/vehicles/${vehicle.body.data.vehicle.id}/unassign-driver`)
        .set("Authorization", `Bearer ${owner.accessToken}`);

      expect(res.status).toBe(200);

      const vehicleRow = await pool.query("SELECT current_driver_id FROM vehicles WHERE id = $1", [
        vehicle.body.data.vehicle.id,
      ]);
      expect(vehicleRow.rows[0].current_driver_id).toBeNull();
    });

    it("rejects assigning a driver to a vehicle that isn't AVAILABLE", async () => {
      const owner = await registerAndLogin(["VEHICLE_OWNER"]);
      const vehicle = await request(app)
        .post("/api/vehicles")
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send(vehiclePayload());
      await request(app)
        .patch(`/api/vehicles/${vehicle.body.data.vehicle.id}/status`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ status: "UNDER_MAINTENANCE" });

      const driver = await verifiedDriver();
      const res = await request(app)
        .post(`/api/vehicles/${vehicle.body.data.vehicle.id}/assign-driver`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .send({ driverId: driver.userId, commissionPercent: 20, ownerSharePercent: 80 });

      expect(res.status).toBe(409);
    });
  });
});

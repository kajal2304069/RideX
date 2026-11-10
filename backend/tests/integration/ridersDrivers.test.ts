import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { closeTestDb } from "./testUtils";
import { redis } from "../../src/config/redis";

const app = createApp();

async function resetTables() {
  await pool.query(
    `TRUNCATE riders, drivers, refresh_tokens, users RESTART IDENTITY CASCADE`
  );
}

async function registerAndLogin(overrides: Partial<{ email: string; roles: string[] }> = {}) {
  const email = overrides.email ?? `user-${Date.now()}-${Math.random().toString(36).slice(2)}@ridex.dev`;
  const res = await request(app).post("/api/auth/register").send({
    email,
    password: "Passw0rd123",
    fullName: "Test User",
    roles: overrides.roles ?? ["RIDER"],
  });
  return { userId: res.body.data.user.id, accessToken: res.body.data.accessToken, email };
}

/** Promotes a user directly via SQL - simulates "an admin already exists"
 * without a public admin-creation endpoint (ADMIN can't self-register,
 * see Phase 2's registration validator). */
async function promoteToAdmin(userId: string) {
  await pool.query(`UPDATE users SET roles = array_append(roles, 'ADMIN') WHERE id = $1`, [userId]);
}

describe("Riders module (live DB)", () => {
  beforeEach(resetTables);

  it("auto-provisions a rider profile atomically at registration", async () => {
    const { accessToken } = await registerAndLogin({ roles: ["RIDER"] });

    const res = await request(app).get("/api/riders/me").set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.rider.totalRides).toBe(0);
    expect(res.body.data.rider.ratingAvg).toBe(5);
  });

  it("rejects access from a user without the RIDER role", async () => {
    const { accessToken } = await registerAndLogin({ roles: ["DRIVER"] });

    const res = await request(app).get("/api/riders/me").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe("Drivers module (live DB)", () => {
  beforeEach(resetTables);
  afterAll(async () => {
    // Single shared pool/redis connection across both describe blocks in
    // this file - only the LAST describe block's afterAll tears it down.
    await closeTestDb();
    redis.disconnect();
  });

  describe("Onboarding", () => {
    it("creates a PENDING driver profile for a DRIVER-role user", async () => {
      const { accessToken } = await registerAndLogin({ roles: ["DRIVER"] });

      const res = await request(app)
        .post("/api/drivers/onboard")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ licenseNumber: "DL-LIVE-001", licenseExpiry: "2030-06-30" });

      expect(res.status).toBe(201);
      expect(res.body.data.driver.verificationStatus).toBe("PENDING");
      expect(res.body.data.driver.isOnline).toBe(false);
    });

    it("rejects onboarding from a non-DRIVER user", async () => {
      const { accessToken } = await registerAndLogin({ roles: ["RIDER"] });

      const res = await request(app)
        .post("/api/drivers/onboard")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ licenseNumber: "DL-LIVE-002", licenseExpiry: "2030-06-30" });

      expect(res.status).toBe(403);
    });

    it("rejects a duplicate onboard for the same user", async () => {
      const { accessToken } = await registerAndLogin({ roles: ["DRIVER"] });
      await request(app)
        .post("/api/drivers/onboard")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ licenseNumber: "DL-LIVE-003", licenseExpiry: "2030-06-30" });

      const res = await request(app)
        .post("/api/drivers/onboard")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ licenseNumber: "DL-LIVE-004", licenseExpiry: "2030-06-30" });

      expect(res.status).toBe(409);
    });

    it("rejects a license number already used by a different driver", async () => {
      const first = await registerAndLogin({ roles: ["DRIVER"] });
      await request(app)
        .post("/api/drivers/onboard")
        .set("Authorization", `Bearer ${first.accessToken}`)
        .send({ licenseNumber: "DL-SHARED-001", licenseExpiry: "2030-06-30" });

      const second = await registerAndLogin({ roles: ["DRIVER"] });
      const res = await request(app)
        .post("/api/drivers/onboard")
        .set("Authorization", `Bearer ${second.accessToken}`)
        .send({ licenseNumber: "DL-SHARED-001", licenseExpiry: "2031-01-01" });

      expect(res.status).toBe(409);
    });

    it("rejects a malformed licenseExpiry via validation", async () => {
      const { accessToken } = await registerAndLogin({ roles: ["DRIVER"] });

      const res = await request(app)
        .post("/api/drivers/onboard")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ licenseNumber: "DL-LIVE-005", licenseExpiry: "not-a-date" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Online/offline + verification workflow", () => {
    it("blocks going online before verification, allows it after admin approval", async () => {
      const driver = await registerAndLogin({ roles: ["DRIVER"] });
      await request(app)
        .post("/api/drivers/onboard")
        .set("Authorization", `Bearer ${driver.accessToken}`)
        .send({ licenseNumber: "DL-FLOW-001", licenseExpiry: "2030-06-30" });

      const blockedAttempt = await request(app)
        .post("/api/drivers/online")
        .set("Authorization", `Bearer ${driver.accessToken}`);
      expect(blockedAttempt.status).toBe(403);

      // Promote a separate user to admin and verify the driver
      const admin = await registerAndLogin({ roles: ["RIDER"] });
      await promoteToAdmin(admin.userId);
      // Access token was minted before the promotion, so log in again to
      // get a fresh token carrying the ADMIN role (roles are baked into
      // the access token at issuance - see common/jwt.ts).
      const adminLogin = await request(app)
        .post("/api/auth/login")
        .send({ email: admin.email, password: "Passw0rd123" });
      const adminToken = adminLogin.body.data.accessToken;

      const verifyRes = await request(app)
        .patch(`/api/drivers/${driver.userId}/verification`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "VERIFIED" });
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.data.driver.verificationStatus).toBe("VERIFIED");

      const allowedAttempt = await request(app)
        .post("/api/drivers/online")
        .set("Authorization", `Bearer ${driver.accessToken}`);
      expect(allowedAttempt.status).toBe(200);
      expect(allowedAttempt.body.data.driver.isOnline).toBe(true);

      const offlineRes = await request(app)
        .post("/api/drivers/offline")
        .set("Authorization", `Bearer ${driver.accessToken}`);
      expect(offlineRes.status).toBe(200);
      expect(offlineRes.body.data.driver.isOnline).toBe(false);
    });

    it("rejects the verification endpoint for a non-admin caller", async () => {
      const driver = await registerAndLogin({ roles: ["DRIVER"] });
      await request(app)
        .post("/api/drivers/onboard")
        .set("Authorization", `Bearer ${driver.accessToken}`)
        .send({ licenseNumber: "DL-FLOW-002", licenseExpiry: "2030-06-30" });

      const res = await request(app)
        .patch(`/api/drivers/${driver.userId}/verification`)
        .set("Authorization", `Bearer ${driver.accessToken}`) // driver, not admin
        .send({ status: "VERIFIED" });

      expect(res.status).toBe(403);
    });

    it("lists pending-verification drivers for an admin", async () => {
      const driver = await registerAndLogin({ roles: ["DRIVER"] });
      await request(app)
        .post("/api/drivers/onboard")
        .set("Authorization", `Bearer ${driver.accessToken}`)
        .send({ licenseNumber: "DL-FLOW-003", licenseExpiry: "2030-06-30" });

      const admin = await registerAndLogin({ roles: ["RIDER"] });
      await promoteToAdmin(admin.userId);
      const adminLogin = await request(app)
        .post("/api/auth/login")
        .send({ email: admin.email, password: "Passw0rd123" });

      const res = await request(app)
        .get("/api/drivers/pending")
        .set("Authorization", `Bearer ${adminLogin.body.data.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.drivers.some((d: { userId: string }) => d.userId === driver.userId)).toBe(true);
    });
  });
});

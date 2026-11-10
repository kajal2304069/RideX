import request from "supertest";
import { createApp } from "../../src/app";
import { resetAuthTables, closeTestDb } from "./testUtils";
import { redis } from "../../src/config/redis";

const app = createApp();

const VALID_USER = {
  email: "test.rider@ridex.dev",
  password: "Passw0rd123",
  fullName: "Test Rider",
  roles: ["RIDER", "VEHICLE_OWNER"],
};

describe("Auth flow (live DB)", () => {
  beforeEach(async () => {
    await resetAuthTables();
  });

  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  describe("POST /api/auth/register", () => {
    it("creates a user, returns an access token, and sets a refresh cookie", async () => {
      const res = await request(app).post("/api/auth/register").send(VALID_USER);

      expect(res.status).toBe(201);
      expect(res.body.data.user.email).toBe(VALID_USER.email);
      expect(res.body.data.user.roles).toEqual(["RIDER", "VEHICLE_OWNER"]);
      expect(res.body.data.user).not.toHaveProperty("password_hash");
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(res.headers["set-cookie"]?.[0]).toMatch(/ridex_refresh_token=/);
    });

    it("rejects a weak password with field-level detail", async () => {
      const res = await request(app)
        .post("/api/auth/register")
        .send({ ...VALID_USER, password: "weak" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects duplicate email registration with a generic message (no enumeration)", async () => {
      await request(app).post("/api/auth/register").send(VALID_USER);
      const res = await request(app).post("/api/auth/register").send(VALID_USER);

      expect(res.status).toBe(409);
      expect(res.body.error.message).not.toMatch(/already exists|taken/i);
    });

    it("rejects self-assignment of the ADMIN role", async () => {
      const res = await request(app)
        .post("/api/auth/register")
        .send({ ...VALID_USER, roles: ["ADMIN"] });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/auth/login", () => {
    beforeEach(async () => {
      await request(app).post("/api/auth/register").send(VALID_USER);
    });

    it("logs in with correct credentials", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: VALID_USER.email, password: VALID_USER.password });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
    });

    it("returns the same generic error for wrong password as for unknown email", async () => {
      const wrongPassword = await request(app)
        .post("/api/auth/login")
        .send({ email: VALID_USER.email, password: "WrongPass1" });
      const unknownEmail = await request(app)
        .post("/api/auth/login")
        .send({ email: "nobody@ridex.dev", password: "WrongPass1" });

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns the current user when a valid access token is provided", async () => {
      const register = await request(app).post("/api/auth/register").send(VALID_USER);
      const token = register.body.data.accessToken;

      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe(VALID_USER.email);
    });

    it("rejects requests with no Authorization header", async () => {
      const res = await request(app).get("/api/auth/me");
      expect(res.status).toBe(401);
    });

    it("rejects requests with a malformed token", async () => {
      const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer not-a-real-token");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/auth/refresh — rotation and reuse detection", () => {
    async function registerAndGetCookie() {
      const res = await request(app).post("/api/auth/register").send(VALID_USER);
      const cookie = res.headers["set-cookie"][0];
      return cookie;
    }

    it("issues a new access token and rotates the refresh cookie", async () => {
      const cookie = await registerAndGetCookie();

      const res = await request(app).post("/api/auth/refresh").set("Cookie", cookie);

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      const newCookie = res.headers["set-cookie"][0];
      expect(newCookie).toMatch(/ridex_refresh_token=/);
      expect(newCookie).not.toBe(cookie);
    });

    it("rejects reuse of an already-rotated refresh token and revokes the whole session chain", async () => {
      const originalCookie = await registerAndGetCookie();

      const firstRefresh = await request(app).post("/api/auth/refresh").set("Cookie", originalCookie);
      const rotatedCookie = firstRefresh.headers["set-cookie"][0];

      // Replay the OLD (already-rotated-away) token - this is the theft scenario.
      const replay = await request(app).post("/api/auth/refresh").set("Cookie", originalCookie);
      expect(replay.status).toBe(401);

      // The legitimate rotated token must ALSO now be dead, because we can't
      // tell which of the two holders is the attacker.
      const legitAfterTheftSignal = await request(app).post("/api/auth/refresh").set("Cookie", rotatedCookie);
      expect(legitAfterTheftSignal.status).toBe(401);
    });

    it("rejects a refresh call with no token at all", async () => {
      const res = await request(app).post("/api/auth/refresh");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("revokes the refresh token so it can no longer be used", async () => {
      const register = await request(app).post("/api/auth/register").send(VALID_USER);
      const cookie = register.headers["set-cookie"][0];

      const logout = await request(app).post("/api/auth/logout").set("Cookie", cookie);
      expect(logout.status).toBe(200);

      const refreshAfterLogout = await request(app).post("/api/auth/refresh").set("Cookie", cookie);
      expect(refreshAfterLogout.status).toBe(401);
    });
  });
});

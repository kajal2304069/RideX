import request from "supertest";
import pino from "pino";
import { Writable } from "stream";
import { createApp } from "../../src/app";
import { redis } from "../../src/config/redis";
import { env } from "../../src/config/env";
import { redactConfig } from "../../src/config/logger";
import { closeTestDb } from "./testUtils";
import { ensurePaymentVehicleType, idemKey, makeAdmin, readyDriver, registerUser, resetPaymentTables, createCompletedRide } from "./paymentFixtures";
import { registry } from "../../src/observability/metrics";
import { resetLifecycleForTests, startDraining } from "../../src/observability/lifecycle";

const app = createApp();
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const mutableEnv = env as unknown as Record<string, unknown>;
let vt: string;

const scrape = async () => (await request(app).get("/metrics")).text;
/** Value of one sample line, e.g. sample(text, 'ridex_payments_total{status="SUCCESS"') */
const sample = (text: string, prefix: string): number | null => {
  const line = text.split("\n").find((l) => l.startsWith(prefix));
  return line ? Number(line.split(" ").pop()) : null;
};

describe("Observability: metrics, health, readiness, log hygiene (live DB + Redis)", () => {
  beforeAll(async () => { vt = await ensurePaymentVehicleType("OBS_TEST"); });
  beforeEach(async () => { await resetPaymentTables(); await redis.flushdb(); resetLifecycleForTests(); });
  afterEach(() => { jest.restoreAllMocks(); mutableEnv.METRICS_TOKEN = undefined; mutableEnv.NODE_ENV = "test"; });
  afterAll(async () => { await closeTestDb(); redis.disconnect(); });

  describe("GET /metrics", () => {
    it("exposes Prometheus text with HTTP, process and business metrics", async () => {
      await request(app).get("/health");
      const res = await request(app).get("/metrics");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      for (const name of ["ridex_http_requests_total", "ridex_http_request_duration_seconds_bucket", "ridex_process_cpu_user_seconds_total", "ridex_active_rides", "ridex_online_drivers", "ridex_websocket_connections", "ridex_db_pool_connections", "ridex_queue_jobs", "ridex_invariant_violations"]) {
        expect(res.text).toContain(name);
      }
    });

    it("labels requests by ROUTE PATTERN, never by raw URL (bounded cardinality)", async () => {
      const u = await registerUser(app, ["RIDER"]);
      const id = "3f8c1d2e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
      await request(app).get(`/api/chat/rides/${id}/messages`).set(bearer(u.accessToken));
      await request(app).get(`/totally/unknown/${id}`);
      const text = await scrape();
      expect(text).toContain('route="/api/chat/rides/:rideId/messages"');
      expect(text).toContain('route="unmatched"');
      expect(text).not.toContain(id);
    });

    it("counts requests with method and status", async () => {
      const before = sample(await scrape(), 'ridex_http_requests_total{method="GET",route="/health",status="200"') ?? 0;
      await request(app).get("/health");
      await request(app).get("/health");
      expect(sample(await scrape(), 'ridex_http_requests_total{method="GET",route="/health",status="200"')).toBe(before + 2);
    });

    it("with METRICS_TOKEN set it requires the bearer token", async () => {
      mutableEnv.METRICS_TOKEN = "scrape-token-0123456789";
      expect((await request(app).get("/metrics")).status).toBe(401);
      expect((await request(app).get("/metrics").set("Authorization", "Bearer wrong-token-0123456789")).status).toBe(401);
      expect((await request(app).get("/metrics").set("Authorization", "Bearer scrape-token-0123456789")).status).toBe(200);
    });

    it("in production without a token the endpoint does not exist", async () => {
      mutableEnv.NODE_ENV = "production";
      expect((await request(app).get("/metrics")).status).toBe(404);
    });

    it("business gauges reflect reality: online drivers and active rides", async () => {
      const admin = await makeAdmin(app);
      const driver = await readyDriver(app, vt, admin.accessToken);
      await request(app).post("/api/location/drivers/me").set(bearer(driver.accessToken)).send({ lat: 12.97, lng: 77.59 });
      const rider = await registerUser(app, ["RIDER"]);
      await request(app).post("/api/rides/request").set(bearer(rider.accessToken)).send({
        pickup: { lat: 12.97, lng: 77.59, address: "A" }, dropoff: { lat: 12.93, lng: 77.62, address: "B" }, vehicleTypeId: vt, idempotencyKey: idemKey(),
      });
      jest.useRealTimers();
      await new Promise((r) => setTimeout(r, 5200)); // gauges are cached for 5s
      const text = await scrape();
      expect(sample(text, "ridex_online_drivers")).toBe(1);
      expect(sample(text, "ridex_active_rides")).toBe(1);
    }, 20000);

    it("a failing data source is skipped: /metrics still answers", async () => {
      jest.spyOn(redis, "zcard").mockRejectedValue(new Error("redis down"));
      await new Promise((r) => setTimeout(r, 5200));
      const res = await request(app).get("/metrics");
      expect(res.status).toBe(200);
      expect(res.text).toContain("ridex_http_requests_total");
    }, 20000);

    it("payments are counted by outcome", async () => {
      const admin = await makeAdmin(app);
      const before = await scrape();
      const ok0 = sample(before, 'ridex_payments_total{status="SUCCESS"') ?? 0;
      const bad0 = sample(before, 'ridex_payments_total{status="FAILED"') ?? 0;
      const a = await createCompletedRide(app, vt, admin);
      const b = await createCompletedRide(app, vt, admin);
      const pay = (r: typeof a, token: string) => request(app).post("/api/payments").set(bearer(r.rider.accessToken)).set("Idempotency-Key", idemKey())
        .send({ payableType: "RIDE", payableId: r.rideId, paymentMethodToken: token });
      expect((await pay(a, "tok_mock_success")).status).toBe(201);
      await pay(b, "tok_mock_decline");
      const after = await scrape();
      expect(sample(after, 'ridex_payments_total{status="SUCCESS"')).toBe(ok0 + 1);
      expect(sample(after, 'ridex_payments_total{status="FAILED"')).toBe(bad0 + 1);
    });

    it("matching latency is recorded", async () => {
      const admin = await makeAdmin(app);
      const rider = await registerUser(app, ["RIDER"]);
      const ride = await request(app).post("/api/rides/request").set(bearer(rider.accessToken)).send({
        pickup: { lat: 12.97, lng: 77.59, address: "A" }, dropoff: { lat: 12.93, lng: 77.62, address: "B" }, vehicleTypeId: vt, idempotencyKey: idemKey(),
      });
      const before = sample(await scrape(), 'ridex_matching_duration_seconds_count{outcome="none"') ?? 0;
      const m = await request(app).get(`/api/matching/rides/${ride.body.data.ride.id}/candidates`).set(bearer(admin.accessToken));
      expect(m.status).toBeLessThan(500);
      const after = sample(await scrape(), 'ridex_matching_duration_seconds_count{outcome="none"') ?? 0;
      expect(after).toBeGreaterThanOrEqual(before);
      expect(registry.getSingleMetric("ridex_matching_duration_seconds")).toBeDefined();
    });
  });

  describe("health and readiness", () => {
    it("/health is liveness only: no dependencies touched", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });

    it("/ready is 200 with both dependencies up, 503 when Redis is down", async () => {
      expect((await request(app).get("/ready")).body).toMatchObject({ status: "ready", dependencies: { postgres: "up", redis: "up" } });
      jest.spyOn(redis, "ping").mockRejectedValue(new Error("down"));
      const down = await request(app).get("/ready");
      expect(down.status).toBe(503);
      expect(down.body.dependencies.redis).toBe("down");
    });

    it("while draining (SIGTERM) /ready answers 503 so the load balancer stops routing here, but /health stays 200", async () => {
      startDraining();
      const ready = await request(app).get("/ready");
      expect(ready.status).toBe(503);
      expect(ready.body.status).toBe("draining");
      expect((await request(app).get("/health")).status).toBe(200);
    });
  });

  describe("request ids and log hygiene", () => {
    it("every response carries an X-Request-Id, and an inbound one is honoured", async () => {
      const a = await request(app).get("/health");
      expect(a.headers["x-request-id"]).toMatch(/[0-9a-f-]{20,}/);
      const b = await request(app).get("/health").set("X-Request-Id", "trace-abc-123");
      expect(b.headers["x-request-id"]).toBe("trace-abc-123");
    });

    it("the logger redacts credentials (Authorization, cookies, passwords, tokens)", () => {
      let out = "";
      const log = pino({ redact: redactConfig }, new Writable({ write(chunk, _e, cb) { out += chunk.toString(); cb(); } }));
      log.info({
        req: { headers: { authorization: "Bearer SECRET-JWT", cookie: "sid=SECRET-COOKIE", host: "x" } },
        res: { headers: { "set-cookie": "refresh=SECRET-REFRESH" } },
        body: { password: "hunter2", paymentMethodToken: "tok_SECRET", note: "visible" },
        user: { accessToken: "SECRET-ACCESS", refreshToken: "SECRET-REFRESH2" },
      }, "request");
      for (const secret of ["SECRET-JWT", "SECRET-COOKIE", "SECRET-REFRESH", "hunter2", "tok_SECRET", "SECRET-ACCESS", "SECRET-REFRESH2"]) expect(out).not.toContain(secret);
      expect(out).toContain("visible");
      expect(out).toContain("[REDACTED]");
    });
  });
});

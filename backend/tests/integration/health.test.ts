import request from "supertest";
import { createApp } from "../../src/app";

describe("GET /health", () => {
  const app = createApp();

  it("returns 200 and liveness status without requiring DB/Redis", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptimeSeconds).toBe("number");
  });

  it("returns a request id header for traceability", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-request-id"]).toBeDefined();
  });
});

describe("Unknown routes", () => {
  const app = createApp();

  it("returns a consistent 404 envelope", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

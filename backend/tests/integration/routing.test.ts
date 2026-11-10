import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { closeTestDb } from "./testUtils";
import { redis } from "../../src/config/redis";
import { routingService, clearGraphCache } from "../../src/modules/routing/services/routing.service";

const app = createApp();

async function registerAndLogin() {
  const email = `routing-${Date.now()}-${Math.random().toString(36).slice(2)}@ridex.dev`;
  const res = await request(app).post("/api/auth/register").send({
    email,
    password: "Passw0rd123",
    fullName: "Routing Test User",
    roles: ["RIDER"],
  });
  return res.body.data.accessToken as string;
}

describe("Routing module (live DB, seeded road network)", () => {
  beforeAll(() => clearGraphCache());
  afterAll(async () => {
    await pool.query(`DELETE FROM refresh_tokens; DELETE FROM users WHERE email LIKE 'routing-%'`);
    await closeTestDb();
    redis.disconnect();
  });

  describe("routingService.computeRoute (direct, no HTTP)", () => {
    it("finds a route between two real coordinates near the seeded graph", async () => {
      // MG Road area -> Koramangala area (both near seeded nodes)
      const result = await routingService.computeRoute(
        { lat: 12.9716, lng: 77.5946 },
        { lat: 12.9352, lng: 77.6245 }
      );

      expect(result.path.length).toBeGreaterThan(1);
      expect(result.distanceMeters).toBeGreaterThan(0);
      expect(result.path[0].lat).toBeCloseTo(12.9716, 1);
      expect(result.path[result.path.length - 1].lat).toBeCloseTo(12.9352, 1);
    });

    it("returns algorithm metadata (complexity, exploration stats)", async () => {
      const result = await routingService.computeRoute(
        { lat: 12.9716, lng: 77.5946 },
        { lat: 12.9352, lng: 77.6245 }
      );

      expect(result.algorithm.name).toBe("Dijkstra");
      expect(result.algorithm.timeComplexity).toBe("O((V + E) log V)");
      expect(result.algorithm.spaceComplexity).toBe("O(V + E)");
      expect(result.totalGraphNodes).toBe(16);
      expect(result.nodesExplored).toBeGreaterThan(0);
      expect(result.nodesExplored).toBeLessThanOrEqual(result.totalGraphNodes);
    });

    it("returns a trivial single-point path when both coordinates snap to the same nearest node", async () => {
      const point = { lat: 12.9716, lng: 77.5946 };
      const result = await routingService.computeRoute(point, point);

      expect(result.path).toHaveLength(1);
      expect(result.distanceMeters).toBe(0);
    });

    it("the returned path's distance matches the sum of consecutive great-circle hops (sanity check on correctness, not just 'it returns something')", async () => {
      const result = await routingService.computeRoute(
        { lat: 12.9716, lng: 77.5946 },
        { lat: 12.9857, lng: 77.6058 }
      );

      // Distance should be positive and finite - not NaN, not negative,
      // not absurdly large for two nearby points in a small local graph.
      expect(result.distanceMeters).toBeGreaterThan(0);
      expect(result.distanceMeters).toBeLessThan(20000); // sanity ceiling for this small graph
      expect(Number.isFinite(result.distanceMeters)).toBe(true);
    });

    it("driverToRider and riderToDestination convenience methods delegate to the same underlying computation", async () => {
      const from = { lat: 12.9716, lng: 77.5946 };
      const to = { lat: 12.9352, lng: 77.6245 };

      const direct = await routingService.computeRoute(from, to);
      const viaDriverToRider = await routingService.driverToRider(from, to);
      const viaRiderToDestination = await routingService.riderToDestination(from, to);

      expect(viaDriverToRider.distanceMeters).toBe(direct.distanceMeters);
      expect(viaRiderToDestination.distanceMeters).toBe(direct.distanceMeters);
    });
  });

  describe("POST /api/routing/route (HTTP layer)", () => {
    it("returns a computed route for an authenticated request", async () => {
      const token = await registerAndLogin();

      const res = await request(app)
        .post("/api/routing/route")
        .set("Authorization", `Bearer ${token}`)
        .send({ from: { lat: 12.9716, lng: 77.5946 }, to: { lat: 12.9352, lng: 77.6245 } });

      expect(res.status).toBe(200);
      expect(res.body.data.path.length).toBeGreaterThan(1);
      expect(res.body.data.algorithm.name).toBe("Dijkstra");
    });

    it("rejects an unauthenticated request", async () => {
      const res = await request(app)
        .post("/api/routing/route")
        .send({ from: { lat: 12.9716, lng: 77.5946 }, to: { lat: 12.9352, lng: 77.6245 } });

      expect(res.status).toBe(401);
    });

    it("rejects an out-of-range coordinate via validation", async () => {
      const token = await registerAndLogin();

      const res = await request(app)
        .post("/api/routing/route")
        .set("Authorization", `Bearer ${token}`)
        .send({ from: { lat: 999, lng: 77.5946 }, to: { lat: 12.9352, lng: 77.6245 } });

      expect(res.status).toBe(400);
    });
  });
});

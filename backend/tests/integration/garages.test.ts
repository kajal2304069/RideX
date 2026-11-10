import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";
import { registerUser } from "./paymentFixtures";
import { bearer, CENTER, createGarage, offsetMeters, registerGarageOwner, resetGarageTables } from "./garageFixtures";

const app = createApp();

describe("Garages module (live DB + PostGIS)", () => {
  beforeEach(async () => {
    await resetGarageTables();
    await redis.flushdb();
  });
  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  describe("creating and updating", () => {
    it("lets a GARAGE_OWNER create a garage and returns lat/lng (no PostGIS leakage)", async () => {
      const owner = await registerGarageOwner(app);
      const res = await request(app).post("/api/garages").set(bearer(owner.accessToken))
        .send({ name: "Speedy Fix", lat: 12.97, lng: 77.59, address: "MG Road", openingHours: { mon: "09:00-18:00", sat: "10:00-14:00" }, priceRange: "$$" });

      expect(res.status).toBe(201);
      expect(res.body.data.garage).toMatchObject({ name: "Speedy Fix", location: { lat: 12.97, lng: 77.59 }, ownerId: owner.userId, isActive: true });
      expect(res.body.data.garage.openingHours.mon).toBe("09:00-18:00");
    });

    it("forbids other roles and unauthenticated callers", async () => {
      const rider = await registerUser(app, ["RIDER"]);
      expect((await request(app).post("/api/garages").set(bearer(rider.accessToken)).send({ name: "x1", lat: 1, lng: 1, address: "abc" })).status).toBe(403);
      expect((await request(app).post("/api/garages").send({})).status).toBe(401);
    });

    it.each([
      ["latitude out of range", { lat: 91 }],
      ["bad opening hours format", { openingHours: { mon: "9am-6pm" } }],
      ["unknown weekday", { openingHours: { funday: "09:00-18:00" } }],
      ["unknown field (strict)", { ownerId: "x" }],
      ["name too short", { name: "a" }],
    ])("rejects %s", async (_label, patch) => {
      const owner = await registerGarageOwner(app);
      const res = await request(app).post("/api/garages").set(bearer(owner.accessToken))
        .send({ name: "Valid Name", lat: 12.9, lng: 77.5, address: "Valid address", ...patch });
      expect(res.status).toBe(400);
    });

    it("lists only my own garages", async () => {
      const a = await registerGarageOwner(app);
      const b = await registerGarageOwner(app);
      await createGarage(app, a, { name: "A1" });
      await createGarage(app, a, { name: "A2" });
      await createGarage(app, b, { name: "B1" });

      const res = await request(app).get("/api/garages/mine").set(bearer(a.accessToken));
      expect(res.body.data.garages.map((g: { name: string }) => g.name).sort()).toEqual(["A1", "A2"]);
    });

    it("updates fields, and moving requires lat and lng together", async () => {
      const owner = await registerGarageOwner(app);
      const { garageId } = await createGarage(app, owner);

      const ok = await request(app).patch(`/api/garages/${garageId}`).set(bearer(owner.accessToken)).send({ name: "Renamed", phone: null, lat: 13.0, lng: 77.6 });
      expect(ok.status).toBe(200);
      expect(ok.body.data.garage).toMatchObject({ name: "Renamed", phone: null, location: { lat: 13, lng: 77.6 } });

      expect((await request(app).patch(`/api/garages/${garageId}`).set(bearer(owner.accessToken)).send({ lat: 13.0 })).status).toBe(400);
      expect((await request(app).patch(`/api/garages/${garageId}`).set(bearer(owner.accessToken)).send({})).status).toBe(400);
    });

    it("hides another owner's garage behind a 404 on update", async () => {
      const a = await registerGarageOwner(app);
      const b = await registerGarageOwner(app);
      const { garageId } = await createGarage(app, a);
      const res = await request(app).patch(`/api/garages/${garageId}`).set(bearer(b.accessToken)).send({ name: "Hijacked" });
      expect(res.status).toBe(404);
    });
  });

  describe("nearby search", () => {
    it("returns garages within the radius, nearest first, with distance in metres", async () => {
      const owner = await registerGarageOwner(app);
      await createGarage(app, owner, { name: "Far", at: offsetMeters(3000) });
      await createGarage(app, owner, { name: "Near", at: offsetMeters(500) });
      await createGarage(app, owner, { name: "Mid", at: offsetMeters(1500) });
      await createGarage(app, owner, { name: "Way out", at: offsetMeters(30000) });
      const rider = await registerUser(app, ["RIDER"]);

      const res = await request(app).get(`/api/garages/nearby?lat=${CENTER.lat}&lng=${CENTER.lng}&radiusMeters=5000`).set(bearer(rider.accessToken));

      expect(res.status).toBe(200);
      const garages = res.body.data.garages;
      expect(garages.map((g: { name: string }) => g.name)).toEqual(["Near", "Mid", "Far"]);
      const d = garages.map((g: { distanceMeters: number }) => g.distanceMeters);
      expect(d[0]).toBeGreaterThan(450);
      expect(d[0]).toBeLessThan(550);
      expect(d).toEqual([...d].sort((x, y) => x - y));
    });

    it("filters by service type and includes each garage's service list", async () => {
      const owner = await registerGarageOwner(app);
      await createGarage(app, owner, { name: "Tyres", at: offsetMeters(300), services: ["TYRE_REPLACEMENT"] });
      await createGarage(app, owner, { name: "Brakes+Oil", at: offsetMeters(600), services: ["BRAKE_REPAIR", "OIL_CHANGE"] });
      const rider = await registerUser(app, ["RIDER"]);

      const res = await request(app).get(`/api/garages/nearby?lat=${CENTER.lat}&lng=${CENTER.lng}&serviceType=BRAKE_REPAIR`).set(bearer(rider.accessToken));

      expect(res.body.data.garages).toHaveLength(1);
      expect(res.body.data.garages[0].name).toBe("Brakes+Oil");
      expect(res.body.data.garages[0].serviceTypes).toEqual(["BRAKE_REPAIR", "OIL_CHANGE"]);
    });

    it("excludes inactive garages and honours limit", async () => {
      const owner = await registerGarageOwner(app);
      const hidden = await createGarage(app, owner, { name: "Closed", at: offsetMeters(100) });
      await createGarage(app, owner, { name: "G1", at: offsetMeters(200) });
      await createGarage(app, owner, { name: "G2", at: offsetMeters(300) });
      await request(app).patch(`/api/garages/${hidden.garageId}`).set(bearer(owner.accessToken)).send({ isActive: false });
      const rider = await registerUser(app, ["RIDER"]);

      const all = await request(app).get(`/api/garages/nearby?lat=${CENTER.lat}&lng=${CENTER.lng}`).set(bearer(rider.accessToken));
      expect(all.body.data.garages.map((g: { name: string }) => g.name)).toEqual(["G1", "G2"]);

      const one = await request(app).get(`/api/garages/nearby?lat=${CENTER.lat}&lng=${CENTER.lng}&limit=1`).set(bearer(rider.accessToken));
      expect(one.body.data.garages).toHaveLength(1);
    });

    it("validates its query and requires auth", async () => {
      const rider = await registerUser(app, ["RIDER"]);
      expect((await request(app).get("/api/garages/nearby?lat=95&lng=0").set(bearer(rider.accessToken))).status).toBe(400);
      expect((await request(app).get("/api/garages/nearby?lat=1&lng=1&radiusMeters=999999").set(bearer(rider.accessToken))).status).toBe(400);
      expect((await request(app).get("/api/garages/nearby?lat=1&lng=1&serviceType=NOPE").set(bearer(rider.accessToken))).status).toBe(400);
      expect((await request(app).get("/api/garages/nearby?lat=1&lng=1")).status).toBe(401);
    });

    it("uses the GIST index for the radius filter", async () => {
      // Force the planner's hand on a tiny table, then prove the index is usable.
      await pool.query(`SET enable_seqscan = off`);
      const { rows } = await pool.query(
        `EXPLAIN SELECT id FROM garages WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(77.59, 12.97), 4326)::geography, 5000)`
      );
      await pool.query(`RESET enable_seqscan`);
      expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/garages_location_idx|Index/i);
    });
  });

  describe("public detail", () => {
    it("is readable anonymously for an active garage, without the mechanic roster", async () => {
      const owner = await registerGarageOwner(app);
      const { garageId } = await createGarage(app, owner, { services: ["OIL_CHANGE", "AC_REPAIR"], mechanics: ["Asha"] });

      const res = await request(app).get(`/api/garages/${garageId}`);

      expect(res.status).toBe(200);
      expect(res.body.data.services.map((s: { serviceType: string }) => s.serviceType)).toEqual(["AC_REPAIR", "OIL_CHANGE"]);
      expect(res.body.data.mechanics).toEqual([]);
    });

    it("shows the mechanic roster to the owner and to admins", async () => {
      const owner = await registerGarageOwner(app);
      const { garageId } = await createGarage(app, owner, { mechanics: ["Asha"] });
      const res = await request(app).get(`/api/garages/${garageId}`).set(bearer(owner.accessToken));
      expect(res.body.data.mechanics.map((m: { name: string }) => m.name)).toEqual(["Asha"]);
    });

    it("hides an inactive garage from the public but not from its owner", async () => {
      const owner = await registerGarageOwner(app);
      const { garageId } = await createGarage(app, owner);
      await request(app).patch(`/api/garages/${garageId}`).set(bearer(owner.accessToken)).send({ isActive: false });

      expect((await request(app).get(`/api/garages/${garageId}`)).status).toBe(404);
      expect((await request(app).get(`/api/garages/${garageId}`).set(bearer(owner.accessToken))).status).toBe(200);
    });

    it("rejects a malformed token rather than treating it as anonymous", async () => {
      const owner = await registerGarageOwner(app);
      const { garageId } = await createGarage(app, owner);
      expect((await request(app).get(`/api/garages/${garageId}`).set("Authorization", "Bearer garbage")).status).toBe(401);
    });
  });

  describe("services", () => {
    it("adds a service, refuses a duplicate type, and validates the price range", async () => {
      const owner = await registerGarageOwner(app);
      const { garageId } = await createGarage(app, owner, { services: [] });
      const add = (body: object) => request(app).post(`/api/garages/${garageId}/services`).set(bearer(owner.accessToken)).send(body);

      expect((await add({ serviceType: "OIL_CHANGE", priceFrom: 400, priceTo: 900 })).status).toBe(201);
      expect((await add({ serviceType: "OIL_CHANGE" })).status).toBe(409);
      expect((await add({ serviceType: "BODY_WORK", priceFrom: 900, priceTo: 100 })).status).toBe(400);
      expect((await add({ serviceType: "FLYING" })).status).toBe(400);
    });

    it("removes a service; only the owner may", async () => {
      const a = await registerGarageOwner(app);
      const b = await registerGarageOwner(app);
      const { garageId, services } = await createGarage(app, a, { services: ["OIL_CHANGE"] });
      const url = `/api/garages/${garageId}/services/${services.OIL_CHANGE}`;

      expect((await request(app).delete(url).set(bearer(b.accessToken))).status).toBe(404);
      expect((await request(app).delete(url).set(bearer(a.accessToken))).status).toBe(200);
      expect((await request(app).delete(url).set(bearer(a.accessToken))).status).toBe(404);
    });
  });

  describe("mechanics", () => {
    it("adds, lists (owner/admin only) and deactivates mechanics", async () => {
      const a = await registerGarageOwner(app);
      const b = await registerGarageOwner(app);
      const { garageId, mechanicIds } = await createGarage(app, a, { mechanics: ["Ravi"] });

      const list = await request(app).get(`/api/garages/${garageId}/mechanics`).set(bearer(a.accessToken));
      expect(list.body.data.mechanics).toHaveLength(1);
      expect((await request(app).get(`/api/garages/${garageId}/mechanics`).set(bearer(b.accessToken))).status).toBe(404);

      const off = await request(app).patch(`/api/garages/${garageId}/mechanics/${mechanicIds[0]}`).set(bearer(a.accessToken)).send({ isActive: false });
      expect(off.body.data.mechanic.isActive).toBe(false);
    });

    it("refuses to add a mechanic to someone else's garage", async () => {
      const a = await registerGarageOwner(app);
      const b = await registerGarageOwner(app);
      const { garageId } = await createGarage(app, a);
      const res = await request(app).post(`/api/garages/${garageId}/mechanics`).set(bearer(b.accessToken)).send({ name: "Mallory" });
      expect(res.status).toBe(404);
    });
  });
});

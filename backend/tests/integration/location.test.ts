import { randomUUID } from "crypto";
import { locationService } from "../../src/modules/location/services/location.service";
import { redis } from "../../src/config/redis";
import { pool } from "../../src/db/pool";
import { closeTestDb } from "./testUtils";

/**
 * These tests exercise the Redis GEO logic directly (not through HTTP)
 * since the module's whole reason for existing is its interaction with
 * real Redis GEO commands - a mocked Redis client would just be
 * testing that the mock returns what we told it to return, proving
 * nothing about whether GEOSEARCH/staleness-filtering/persistence
 * throttling actually work.
 *
 * driverId/vehicleId use real UUIDs (not readable string ids) because
 * `vehicle_locations.driver_id`/`vehicle_id` are typed `uuid` in
 * Postgres (Phase 3) - Redis itself doesn't care about the ID format,
 * but the throttled-persistence tests below do touch Postgres.
 */

const BANGALORE = { lat: 12.9716, lng: 77.5946 }; // MG Road
const NEARBY = { lat: 12.972, lng: 77.595 }; // ~70m away
const FAR = { lat: 13.1, lng: 77.75 }; // ~25km away

async function cleanupRedisKeys(driverIds: string[]) {
  await redis.zrem("geo:drivers", ...driverIds);
  for (const id of driverIds) {
    await redis.del(`loc:driver:${id}`);
    await redis.del(`loc:persisted:${id}`);
  }
}

async function cleanupVehicleLocations(driverIds: string[]) {
  if (driverIds.length === 0) return;
  await pool.query(`DELETE FROM vehicle_locations WHERE driver_id = ANY($1::uuid[])`, [driverIds]);
}

/**
 * Pre-marks a driver as "already persisted recently" so
 * `updateDriverLocation` skips its Postgres write entirely. Used by
 * tests that are only exercising Redis GEO behavior - those tests use
 * throwaway UUIDs that don't correspond to real `users`/`vehicles` rows,
 * so letting the persistence path actually fire would trip a foreign
 * key violation unrelated to what the test is checking. The dedicated
 * "throttled Postgres persistence" tests below use real FK-satisfying
 * rows instead, specifically so they CAN exercise that path for real.
 */
async function skipPersistenceForTest(driverId: string) {
  await redis.set(`loc:persisted:${driverId}`, Date.now());
}

describe("Location service (live Redis + Postgres)", () => {
  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  describe("updateDriverLocation + getNearbyDrivers", () => {
    const nearDriverId = randomUUID();
    const farDriverId = randomUUID();

    afterEach(async () => {
      await cleanupRedisKeys([nearDriverId, farDriverId]);
      await cleanupVehicleLocations([nearDriverId, farDriverId]);
    });

    it("finds a nearby driver within the search radius", async () => {
      await skipPersistenceForTest(nearDriverId);
      await locationService.updateDriverLocation(nearDriverId, randomUUID(), "type-1", {
        lat: NEARBY.lat,
        lng: NEARBY.lng,
      });

      const results = await locationService.getNearbyDrivers(BANGALORE.lat, BANGALORE.lng, 2000);
      expect(results.some((d) => d.driverId === nearDriverId)).toBe(true);
    });

    it("excludes a driver outside the search radius", async () => {
      await skipPersistenceForTest(farDriverId);
      await locationService.updateDriverLocation(farDriverId, randomUUID(), "type-1", {
        lat: FAR.lat,
        lng: FAR.lng,
      });

      const results = await locationService.getNearbyDrivers(BANGALORE.lat, BANGALORE.lng, 2000);
      expect(results.some((d) => d.driverId === farDriverId)).toBe(false);
    });

    it("returns results sorted nearest-first", async () => {
      await skipPersistenceForTest(nearDriverId);
      await skipPersistenceForTest(farDriverId);
      await locationService.updateDriverLocation(nearDriverId, randomUUID(), "type-1", {
        lat: NEARBY.lat,
        lng: NEARBY.lng,
      });
      await locationService.updateDriverLocation(farDriverId, randomUUID(), "type-1", {
        lat: 12.98,
        lng: 77.6, // further than NEARBY but still within a wide radius
      });

      const results = await locationService.getNearbyDrivers(BANGALORE.lat, BANGALORE.lng, 10000);
      const nearIndex = results.findIndex((d) => d.driverId === nearDriverId);
      const farIndex = results.findIndex((d) => d.driverId === farDriverId);
      expect(nearIndex).toBeLessThan(farIndex);
    });

    it("filters by vehicleTypeId when provided", async () => {
      await skipPersistenceForTest(nearDriverId);
      await locationService.updateDriverLocation(nearDriverId, randomUUID(), "SEDAN_TYPE", {
        lat: NEARBY.lat,
        lng: NEARBY.lng,
      });

      const matchingType = await locationService.getNearbyDrivers(BANGALORE.lat, BANGALORE.lng, 2000, "SEDAN_TYPE");
      const wrongType = await locationService.getNearbyDrivers(BANGALORE.lat, BANGALORE.lng, 2000, "BIKE_TYPE");

      expect(matchingType.some((d) => d.driverId === nearDriverId)).toBe(true);
      expect(wrongType.some((d) => d.driverId === nearDriverId)).toBe(false);
    });

    it("includes heading and speed when provided", async () => {
      await skipPersistenceForTest(nearDriverId);
      await locationService.updateDriverLocation(nearDriverId, randomUUID(), "type-1", {
        lat: NEARBY.lat,
        lng: NEARBY.lng,
        heading: 180,
        speedKmh: 42,
      });

      const results = await locationService.getNearbyDrivers(BANGALORE.lat, BANGALORE.lng, 2000);
      const found = results.find((d) => d.driverId === nearDriverId);
      expect(found?.heading).toBe(180);
      expect(found?.speedKmh).toBe(42);
    });
  });

  describe("removeDriverLocation", () => {
    const driverId = randomUUID();

    afterEach(() => cleanupRedisKeys([driverId]));

    it("removes a driver from nearby search results immediately", async () => {
      await skipPersistenceForTest(driverId);
      await locationService.updateDriverLocation(driverId, randomUUID(), "type-1", NEARBY);
      let results = await locationService.getNearbyDrivers(BANGALORE.lat, BANGALORE.lng, 2000);
      expect(results.some((d) => d.driverId === driverId)).toBe(true);

      await locationService.removeDriverLocation(driverId);

      results = await locationService.getNearbyDrivers(BANGALORE.lat, BANGALORE.lng, 2000);
      expect(results.some((d) => d.driverId === driverId)).toBe(false);
    });
  });

  describe("staleness filtering", () => {
    const staleDriverId = randomUUID();

    afterEach(() => cleanupRedisKeys([staleDriverId]));

    it("excludes a driver whose last update is older than the staleness threshold", async () => {
      await skipPersistenceForTest(staleDriverId);
      await locationService.updateDriverLocation(staleDriverId, randomUUID(), "type-1", NEARBY);

      // Simulate staleness by backdating the hash's updatedAt field directly,
      // rather than waiting 30 real seconds for the threshold to elapse.
      await redis.hset(`loc:driver:${staleDriverId}`, "updatedAt", Date.now() - 60_000);

      const results = await locationService.getNearbyDrivers(BANGALORE.lat, BANGALORE.lng, 2000);
      expect(results.some((d) => d.driverId === staleDriverId)).toBe(false);
    });

    it("lazily removes stale entries from the GEO set as a side effect of the search", async () => {
      await skipPersistenceForTest(staleDriverId);
      await locationService.updateDriverLocation(staleDriverId, randomUUID(), "type-1", NEARBY);
      await redis.hset(`loc:driver:${staleDriverId}`, "updatedAt", Date.now() - 60_000);

      await locationService.getNearbyDrivers(BANGALORE.lat, BANGALORE.lng, 2000);

      const score = await redis.zscore("geo:drivers", staleDriverId);
      expect(score).toBeNull(); // ZREM'd during the search
    });
  });

  describe("throttled Postgres persistence", () => {
    let driverId: string;
    let vehicleTypeId: string;
    let vehicleId: string;
    let ownerId: string;

    beforeAll(async () => {
      const vt = await pool.query(
        `INSERT INTO vehicle_types (code, display_name) VALUES ('LOC_TEST_TYPE', 'Test')
         ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`
      );
      vehicleTypeId = vt.rows[0].id;

      const owner = await pool.query(
        `INSERT INTO users (email, password_hash, full_name, roles)
         VALUES ('loctest-owner@ridex.dev', 'x', 'Loc Owner', ARRAY['VEHICLE_OWNER']::user_role[])
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`
      );
      ownerId = owner.rows[0].id;

      // vehicle_locations.driver_id references users(id) - needs a real row too.
      const driver = await pool.query(
        `INSERT INTO users (email, password_hash, full_name, roles)
         VALUES ('loctest-driver@ridex.dev', 'x', 'Loc Driver', ARRAY['DRIVER']::user_role[])
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`
      );
      driverId = driver.rows[0].id;

      const vehicle = await pool.query(
        `INSERT INTO vehicles (owner_id, vehicle_type_id, registration_number, brand, model, year)
         VALUES ($1, $2, 'LOC-TEST-001', 'Test', 'Car', 2024)
         ON CONFLICT (registration_number) DO UPDATE SET registration_number = EXCLUDED.registration_number RETURNING id`,
        [ownerId, vehicleTypeId]
      );
      vehicleId = vehicle.rows[0].id;
    });

    afterEach(async () => {
      await cleanupRedisKeys([driverId]);
      await cleanupVehicleLocations([driverId]);
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM vehicles WHERE id = $1`, [vehicleId]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [driverId]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [ownerId]);
      await pool.query(`DELETE FROM vehicle_types WHERE id = $1`, [vehicleTypeId]);
    });

    it("persists the first ping to Postgres", async () => {
      await locationService.updateDriverLocation(driverId, vehicleId, vehicleTypeId, NEARBY);

      const { rows } = await pool.query(`SELECT count(*) FROM vehicle_locations WHERE driver_id = $1`, [driverId]);
      expect(Number(rows[0].count)).toBe(1);
    });

    it("does NOT persist a second ping that arrives immediately after (throttled)", async () => {
      await locationService.updateDriverLocation(driverId, vehicleId, vehicleTypeId, NEARBY);
      await locationService.updateDriverLocation(driverId, vehicleId, vehicleTypeId, {
        lat: NEARBY.lat + 0.0001,
        lng: NEARBY.lng,
      });

      const { rows } = await pool.query(`SELECT count(*) FROM vehicle_locations WHERE driver_id = $1`, [driverId]);
      // Still just 1 row - the second ping was within the throttle window.
      expect(Number(rows[0].count)).toBe(1);
    });
  });
});

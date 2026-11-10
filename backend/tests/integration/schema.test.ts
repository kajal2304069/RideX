import { pool } from "../../src/db/pool";
import { closeTestDb } from "./testUtils";

/**
 * These tests exercise raw schema guarantees (constraints, spatial
 * indexes) directly against the database, independent of any
 * service/repository layer - those come with each module's own phase
 * (vehicles: Phase 5, rides: Phase 6, garages: Phase 14, rentals: Phase
 * 16). The goal here is narrower: prove the Phase 3 migrations produce
 * a schema that actually enforces what it claims to enforce.
 */

async function cleanSchemaTestData() {
  await pool.query(`TRUNCATE rental_bookings, rental_listings, garages, vehicles, vehicle_types, users RESTART IDENTITY CASCADE`);
}

describe("Phase 3 schema guarantees (live Postgres + PostGIS)", () => {
  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await cleanSchemaTestData();
  });

  it("PostGIS is installed and reports a version", async () => {
    const { rows } = await pool.query("SELECT postgis_version()");
    expect(rows[0].postgis_version).toBeDefined();
  });

  describe("Nearby-garage geospatial query", () => {
    async function seedOwnerAndGarages() {
      const { rows: userRows } = await pool.query(
        `INSERT INTO users (email, password_hash, full_name, roles)
         VALUES ('owner-schema-test@ridex.dev', 'x', 'Owner', ARRAY['GARAGE_OWNER']::user_role[])
         RETURNING id`
      );
      const ownerId = userRows[0].id;

      // Rider reference point: MG Road, Bangalore (77.5946, 12.9716)
      await pool.query(
        `INSERT INTO garages (owner_id, name, location, address) VALUES
         ($1, 'Close Garage', ST_SetSRID(ST_MakePoint(77.5950, 12.9720), 4326)::geography, 'near'),
         ($1, 'Mid Garage', ST_SetSRID(ST_MakePoint(77.6100, 12.9850), 4326)::geography, 'mid'),
         ($1, 'Far Garage', ST_SetSRID(ST_MakePoint(77.7500, 13.1000), 4326)::geography, 'far')`,
        [ownerId]
      );
    }

    it("finds only garages within the search radius, ordered nearest-first", async () => {
      await seedOwnerAndGarages();

      const { rows } = await pool.query(`
        SELECT name, ST_Distance(location, ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography) AS distance
        FROM garages
        WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography, 5000)
        ORDER BY location <-> ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography
      `);

      expect(rows.map((r) => r.name)).toEqual(["Close Garage", "Mid Garage"]);
      expect(Number(rows[0].distance)).toBeLessThan(Number(rows[1].distance));
    });

    it("uses the GIST index for the spatial query (not a sequential scan)", async () => {
      await seedOwnerAndGarages();

      const { rows } = await pool.query(`
        EXPLAIN SELECT name FROM garages
        WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography, 5000)
        ORDER BY location <-> ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography
      `);
      const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(plan).toMatch(/garages_location_index/);
    });
  });

  describe("Rental double-booking exclusion constraint", () => {
    async function seedListing() {
      const { rows: userRows } = await pool.query(
        `INSERT INTO users (email, password_hash, full_name, roles)
         VALUES ('renter-schema-test@ridex.dev', 'x', 'Renter', ARRAY['VEHICLE_OWNER']::user_role[])
         RETURNING id`
      );
      const userId = userRows[0].id;

      const { rows: vtRows } = await pool.query(
        `INSERT INTO vehicle_types (code, display_name) VALUES ('SCHEMA_TEST_TYPE', 'Test') RETURNING id`
      );
      const vehicleTypeId = vtRows[0].id;

      const { rows: vehicleRows } = await pool.query(
        `INSERT INTO vehicles (owner_id, vehicle_type_id, registration_number, brand, model, year)
         VALUES ($1, $2, 'SCHEMA-TEST-001', 'Test', 'Car', 2024) RETURNING id`,
        [userId, vehicleTypeId]
      );
      const vehicleId = vehicleRows[0].id;

      const { rows: listingRows } = await pool.query(
        `INSERT INTO rental_listings (owner_id, vehicle_id, daily_price, pickup_location)
         VALUES ($1, $2, 1000, ST_SetSRID(ST_MakePoint(77.59, 12.97), 4326)::geography) RETURNING id`,
        [userId, vehicleId]
      );

      return { listingId: listingRows[0].id, userId };
    }

    it("rejects an overlapping CONFIRMED booking on the same listing", async () => {
      const { listingId, userId } = await seedListing();

      await pool.query(
        `INSERT INTO rental_bookings (rental_listing_id, renter_id, status, start_at, end_at, total_amount)
         VALUES ($1, $2, 'CONFIRMED', '2026-09-10 10:00+00', '2026-09-12 10:00+00', 2000)`,
        [listingId, userId]
      );

      await expect(
        pool.query(
          `INSERT INTO rental_bookings (rental_listing_id, renter_id, status, start_at, end_at, total_amount)
           VALUES ($1, $2, 'CONFIRMED', '2026-09-11 10:00+00', '2026-09-13 10:00+00', 2000)`,
          [listingId, userId]
        )
      ).rejects.toThrow(/exclusion constraint/);
    });

    it("allows a back-to-back booking that starts exactly when the previous one ends", async () => {
      const { listingId, userId } = await seedListing();

      await pool.query(
        `INSERT INTO rental_bookings (rental_listing_id, renter_id, status, start_at, end_at, total_amount)
         VALUES ($1, $2, 'CONFIRMED', '2026-09-10 10:00+00', '2026-09-12 10:00+00', 2000)`,
        [listingId, userId]
      );

      await expect(
        pool.query(
          `INSERT INTO rental_bookings (rental_listing_id, renter_id, status, start_at, end_at, total_amount)
           VALUES ($1, $2, 'CONFIRMED', '2026-09-12 10:00+00', '2026-09-14 10:00+00', 2000)`,
          [listingId, userId]
        )
      ).resolves.toBeDefined();
    });

    it("allows an overlapping booking if the earlier one is CANCELLED", async () => {
      const { listingId, userId } = await seedListing();

      await pool.query(
        `INSERT INTO rental_bookings (rental_listing_id, renter_id, status, start_at, end_at, total_amount)
         VALUES ($1, $2, 'CANCELLED', '2026-09-10 10:00+00', '2026-09-12 10:00+00', 2000)`,
        [listingId, userId]
      );

      await expect(
        pool.query(
          `INSERT INTO rental_bookings (rental_listing_id, renter_id, status, start_at, end_at, total_amount)
           VALUES ($1, $2, 'CONFIRMED', '2026-09-11 10:00+00', '2026-09-13 10:00+00', 2000)`,
          [listingId, userId]
        )
      ).resolves.toBeDefined();
    });

    it("rejects an invalid range where end_at <= start_at", async () => {
      const { listingId, userId } = await seedListing();

      await expect(
        pool.query(
          `INSERT INTO rental_bookings (rental_listing_id, renter_id, status, start_at, end_at, total_amount)
           VALUES ($1, $2, 'CONFIRMED', '2026-09-12 10:00+00', '2026-09-10 10:00+00', 2000)`,
          [listingId, userId]
        )
      ).rejects.toThrow(/rental_bookings_valid_range/);
    });
  });

  describe("Vehicle status enum", () => {
    it("rejects an invalid vehicle status value", async () => {
      const { rows: userRows } = await pool.query(
        `INSERT INTO users (email, password_hash, full_name, roles)
         VALUES ('enum-test@ridex.dev', 'x', 'Owner', ARRAY['VEHICLE_OWNER']::user_role[]) RETURNING id`
      );
      const { rows: vtRows } = await pool.query(
        `INSERT INTO vehicle_types (code, display_name) VALUES ('ENUM_TEST_TYPE', 'Test') RETURNING id`
      );

      await expect(
        pool.query(
          `INSERT INTO vehicles (owner_id, vehicle_type_id, registration_number, brand, model, year, status)
           VALUES ($1, $2, 'ENUM-TEST-001', 'Test', 'Car', 2024, 'NOT_A_REAL_STATUS')`,
          [userRows[0].id, vtRows[0].id]
        )
      ).rejects.toThrow(/invalid input value for enum vehicle_status/);
    });
  });
});

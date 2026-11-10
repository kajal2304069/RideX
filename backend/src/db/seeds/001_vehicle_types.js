require("dotenv/config");
const { Pool } = require("pg");

/**
 * Seeds reference/lookup data that the app cannot function without -
 * NOT sample/demo data (that belongs in a separate demo-seed script per
 * module, added as each module's phase lands). Vehicle types are a
 * foreign key dependency for vehicles, rides, and marketplace listings,
 * so this has to exist before those modules can be exercised at all.
 *
 * Idempotent: safe to run multiple times (ON CONFLICT DO NOTHING).
 */

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const VEHICLE_TYPES = [
  { code: "BIKE", display_name: "Bike", category: "BOTH", capacity: 1, base_fare: 20, per_km_rate: 6, per_min_rate: 0.5 },
  { code: "AUTO", display_name: "Auto", category: "RIDE", capacity: 3, base_fare: 30, per_km_rate: 9, per_min_rate: 0.8 },
  { code: "MINI", display_name: "Mini", category: "BOTH", capacity: 4, base_fare: 40, per_km_rate: 11, per_min_rate: 1.2 },
  { code: "SEDAN", display_name: "Sedan", category: "BOTH", capacity: 4, base_fare: 50, per_km_rate: 13, per_min_rate: 1.5 },
  { code: "SUV", display_name: "SUV", category: "BOTH", capacity: 6, base_fare: 70, per_km_rate: 16, per_min_rate: 2.0 },
  { code: "PREMIUM", display_name: "Premium", category: "RIDE", capacity: 4, base_fare: 100, per_km_rate: 22, per_min_rate: 2.8 },
  { code: "XL", display_name: "XL", category: "BOTH", capacity: 7, base_fare: 90, per_km_rate: 18, per_min_rate: 2.2 },
];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const vt of VEHICLE_TYPES) {
      await client.query(
        `INSERT INTO vehicle_types (code, display_name, category, capacity, base_fare, per_km_rate, per_min_rate)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (code) DO NOTHING`,
        [vt.code, vt.display_name, vt.category, vt.capacity, vt.base_fare, vt.per_km_rate, vt.per_min_rate]
      );
    }
    await client.query("COMMIT");
    console.log(`✅ Seeded ${VEHICLE_TYPES.length} vehicle types`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});

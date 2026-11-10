require("dotenv/config");
const { Pool } = require("pg");

/**
 * Seeds a small, deliberately hand-built road network around a real
 * area of Bangalore (MG Road / Koramangala / Indiranagar) for the
 * Dijkstra routing engine to run over. This is EDUCATIONAL DATA, not an
 * OpenStreetMap import - ~16 intersections forming a connected mesh,
 * small enough to reason about by eye but with actual branching and
 * multiple possible routes between most node pairs, so shortest-path
 * computation is a genuine (if small-scale) demonstration rather than
 * a straight line.
 *
 * Idempotent: clears and re-seeds every run, since the graph is fully
 * synthetic and has no other data depending on specific node IDs
 * surviving between seed runs.
 */

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// [label, lat, lng]
const NODES = [
  ["MG Road Junction", 12.9716, 77.5946],
  ["Trinity Circle", 12.9718, 77.6006],
  ["Ulsoor Lake Junction", 12.9789, 77.6206],
  ["Indiranagar 100ft Road", 12.9719, 77.6412],
  ["Domlur Flyover", 12.9614, 77.6386],
  ["Koramangala 80ft Road", 12.9352, 77.6245],
  ["Sony World Junction", 12.9279, 77.6271],
  ["Forum Mall Junction", 12.9346, 77.6109],
  ["Jayanagar 4th Block", 12.9308, 77.5838],
  ["Lalbagh West Gate", 12.9493, 77.5848],
  ["Richmond Circle", 12.9634, 77.5989],
  ["Shivajinagar Bus Stand", 12.9857, 77.6058],
  ["Cantonment Station", 12.9853, 77.5989],
  ["Cubbon Park Gate", 12.9763, 77.5929],
  ["Vidhana Soudha", 12.9794, 77.5912],
  ["HAL Junction", 12.9584, 77.6633],
];

// Edges as [fromIndex, toIndex] into NODES above - a connected mesh with
// multiple alternate routes between most node pairs (so Dijkstra has real
// choices to make, not just one possible path).
const EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8],
  [8, 9], [9, 10], [10, 0], [0, 13], [13, 14], [14, 11], [11, 12],
  [12, 13], [1, 10], [1, 11], [4, 7], [7, 10], [3, 15], [15, 4],
  [2, 11], [9, 0], [5, 8],
];

const toRad = (deg) => (deg * Math.PI) / 180;
function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[2] - a[2]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query("DELETE FROM road_edges");
    await client.query("DELETE FROM road_nodes");

    const ids = [];
    for (const [label, lat, lng] of NODES) {
      const { rows } = await client.query(
        `INSERT INTO road_nodes (label, location)
         VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography)
         RETURNING id`,
        [label, lng, lat]
      );
      ids.push(rows[0].id);
    }

    for (const [fromIdx, toIdx] of EDGES) {
      const distance = haversineMeters(NODES[fromIdx], NODES[toIdx]);
      await client.query(
        `INSERT INTO road_edges (from_node_id, to_node_id, distance_meters, is_bidirectional)
         VALUES ($1, $2, $3, true)`,
        [ids[fromIdx], ids[toIdx], distance.toFixed(2)]
      );
    }

    await client.query("COMMIT");
    console.log(`✅ Seeded ${NODES.length} road nodes and ${EDGES.length} road edges`);
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

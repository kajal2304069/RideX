/**
 * Migration: 010_create_routing_graph
 *
 * `road_nodes` / `road_edges` model a SIMPLIFIED, EDUCATIONAL road
 * network (spec section 10: "Nodes = intersections, Edges = roads") -
 * this is deliberately NOT a real-world road graph import. A real
 * routing engine (OSRM, Valhalla, Google's) ingests actual OpenStreetMap
 * data with millions of nodes and uses precomputed acceleration
 * structures (contraction hierarchies, graph partitioning) specifically
 * because naive Dijkstra over a true city-scale graph is too slow for
 * per-request use. This graph exists to demonstrate the ALGORITHM
 * correctly on a small, understandable dataset - see
 * `modules/routing/services/routing.service.ts` for the explicit
 * educational-vs-production distinction the spec requires.
 */

exports.up = (pgm) => {
  pgm.createTable("road_nodes", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    label: { type: "text" }, // human-readable name, e.g. "MG Road Junction"
    location: { type: "geography(Point,4326)", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("road_nodes", "location", { method: "gist" });

  pgm.createTable("road_edges", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    from_node_id: { type: "uuid", notNull: true, references: "road_nodes", onDelete: "cascade" },
    to_node_id: { type: "uuid", notNull: true, references: "road_nodes", onDelete: "cascade" },
    distance_meters: { type: "numeric(10,2)", notNull: true }, // the Dijkstra edge weight
    is_bidirectional: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("road_edges", "from_node_id");
  pgm.createIndex("road_edges", "to_node_id");
  pgm.addConstraint("road_edges", "road_edges_no_self_loop", 'CHECK (from_node_id != to_node_id)');
};

exports.down = (pgm) => {
  pgm.dropTable("road_edges");
  pgm.dropTable("road_nodes");
};

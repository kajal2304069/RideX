import { pool } from "../../../db/pool";
import { RoadNodeRecord, RoadEdgeRecord } from "../types/routing.types";

export const routingRepository = {
  async loadAllNodes(): Promise<RoadNodeRecord[]> {
    const { rows } = await pool.query<RoadNodeRecord>(
      `SELECT id, label,
              ST_Y(location::geometry) AS lat,
              ST_X(location::geometry) AS lng
       FROM road_nodes`
    );
    return rows;
  },

  async loadAllEdges(): Promise<RoadEdgeRecord[]> {
    const { rows } = await pool.query<RoadEdgeRecord>(
      `SELECT from_node_id, to_node_id, distance_meters, is_bidirectional FROM road_edges`
    );
    return rows;
  },
};

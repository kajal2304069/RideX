import { pool } from "../../../db/pool";
import { keysetPage, Where } from "../../admin/repositories/pagination";

export interface ChatRide { id: string; rider_id: string; driver_id: string | null; status: string; ended_at: Date | null }

export const chatRepository = {
  async findRide(rideId: string): Promise<ChatRide | null> {
    const { rows } = await pool.query<ChatRide>(
      `SELECT id, rider_id, driver_id, status::text AS status, COALESCE(completed_at, cancelled_at) AS ended_at FROM rides WHERE id = $1`,
      [rideId]
    );
    return rows[0] ?? null;
  },

  async insert(rideId: string, senderId: string, body: string) {
    const { rows } = await pool.query(
      `INSERT INTO messages (conversation_id, ride_id, sender_id, body) VALUES ($1, $1, $2, $3) RETURNING id, ride_id, sender_id, body, created_at`,
      [rideId, senderId, body]
    );
    return rows[0];
  },

  /** Newest first, keyset-paginated; the client reverses for display. */
  list(rideId: string, limit: number, cursor?: string): Promise<{ items: any[]; nextCursor: string | null }> {
    const w = new Where().add((p) => `a.ride_id = ${p(rideId)}`);
    return keysetPage("a.id, a.sender_id, a.body, a.created_at", "FROM messages a", w, limit, cursor);
  },
};

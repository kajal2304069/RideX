import { pool } from "../../../db/pool";
import { RiderRecord } from "../types/riders.types";

export const ridersRepository = {
  async findByUserId(userId: string): Promise<RiderRecord | null> {
    const { rows } = await pool.query<RiderRecord>(`SELECT * FROM riders WHERE user_id = $1`, [userId]);
    return rows[0] ?? null;
  },
};

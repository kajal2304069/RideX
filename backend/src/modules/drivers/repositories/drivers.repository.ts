import { pool } from "../../../db/pool";
import { DriverRecord, VerificationStatus } from "../types/drivers.types";

export const driversRepository = {
  async findByUserId(userId: string): Promise<DriverRecord | null> {
    const { rows } = await pool.query<DriverRecord>(`SELECT * FROM drivers WHERE user_id = $1`, [userId]);
    return rows[0] ?? null;
  },

  async findByLicenseNumber(licenseNumber: string): Promise<DriverRecord | null> {
    const { rows } = await pool.query<DriverRecord>(
      `SELECT * FROM drivers WHERE license_number = $1`,
      [licenseNumber]
    );
    return rows[0] ?? null;
  },

  async create(input: { userId: string; licenseNumber: string; licenseExpiry: string }): Promise<DriverRecord> {
    const { rows } = await pool.query<DriverRecord>(
      `INSERT INTO drivers (user_id, license_number, license_expiry)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.userId, input.licenseNumber, input.licenseExpiry]
    );
    return rows[0];
  },

  async setVerificationStatus(userId: string, status: VerificationStatus): Promise<DriverRecord | null> {
    const { rows } = await pool.query<DriverRecord>(
      `UPDATE drivers SET verification_status = $2, updated_at = now() WHERE user_id = $1 RETURNING *`,
      [userId, status]
    );
    return rows[0] ?? null;
  },

  async setOnlineStatus(userId: string, isOnline: boolean): Promise<DriverRecord | null> {
    const { rows } = await pool.query<DriverRecord>(
      `UPDATE drivers SET is_online = $2, updated_at = now() WHERE user_id = $1 RETURNING *`,
      [userId, isOnline]
    );
    return rows[0] ?? null;
  },

  async listPendingVerification(): Promise<DriverRecord[]> {
    const { rows } = await pool.query<DriverRecord>(
      `SELECT * FROM drivers WHERE verification_status = 'PENDING' ORDER BY created_at ASC`
    );
    return rows;
  },
};

import { PoolClient } from "pg";
import { pool, withTransaction } from "../../../db/pool";
import { AssignmentRecord, VehicleRecord, VehicleStatus } from "../types/vehicles.types";

export const vehiclesRepository = {
  async findAssignableDriverByEmail(email: string): Promise<{ id: string; fullName: string } | null> {
    const { rows } = await pool.query<{ id: string; full_name: string }>(
      `SELECT u.id, u.full_name FROM users u JOIN drivers d ON d.user_id = u.id
       WHERE u.email = $1 AND u.is_active AND d.verification_status = 'VERIFIED'
         AND NOT EXISTS (SELECT 1 FROM vehicle_driver_assignments a WHERE a.driver_id = u.id AND a.status = 'ACTIVE')`,
      [email]
    );
    return rows[0] ? { id: rows[0].id, fullName: rows[0].full_name } : null;
  },

  async listTypes() {
    const { rows } = await pool.query<{ id: string; code: string; display_name: string; category: string; base_fare: string; per_km_rate: string; per_min_rate: string }>(
      `SELECT id, code, display_name, category, base_fare, per_km_rate, per_min_rate FROM vehicle_types WHERE is_active = true ORDER BY base_fare, code`
    );
    return rows;
  },

  async findById(id: string): Promise<VehicleRecord | null> {
    const { rows } = await pool.query<VehicleRecord>(`SELECT * FROM vehicles WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },

  async findByRegistrationNumber(regNumber: string): Promise<VehicleRecord | null> {
    const { rows } = await pool.query<VehicleRecord>(
      `SELECT * FROM vehicles WHERE registration_number = $1`,
      [regNumber]
    );
    return rows[0] ?? null;
  },

  async findByOwner(ownerId: string): Promise<VehicleRecord[]> {
    const { rows } = await pool.query<VehicleRecord>(
      `SELECT * FROM vehicles WHERE owner_id = $1 ORDER BY created_at DESC`,
      [ownerId]
    );
    return rows;
  },

  async create(input: {
    ownerId: string;
    vehicleTypeId: string;
    registrationNumber: string;
    brand: string;
    model: string;
    year: number;
    color?: string;
    fuelType: string;
    transmission: string;
    mileageKm: number;
  }): Promise<VehicleRecord> {
    const { rows } = await pool.query<VehicleRecord>(
      `INSERT INTO vehicles (owner_id, vehicle_type_id, registration_number, brand, model, year, color, fuel_type, transmission, mileage_km)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::fuel_type, $9::transmission_type, $10)
       RETURNING *`,
      [
        input.ownerId,
        input.vehicleTypeId,
        input.registrationNumber,
        input.brand,
        input.model,
        input.year,
        input.color ?? null,
        input.fuelType,
        input.transmission,
        input.mileageKm,
      ]
    );
    return rows[0];
  },

  async updateFields(id: string, fields: { color?: string; mileageKm?: number }): Promise<VehicleRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (fields.color !== undefined) {
      sets.push(`color = $${i++}`);
      values.push(fields.color);
    }
    if (fields.mileageKm !== undefined) {
      sets.push(`mileage_km = $${i++}`);
      values.push(fields.mileageKm);
    }
    sets.push(`updated_at = now()`);
    values.push(id);

    const { rows } = await pool.query<VehicleRecord>(
      `UPDATE vehicles SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    return rows[0] ?? null;
  },

  /**
   * Status update guarded by a WHERE clause on the expected current
   * status - this is the same "optimistic concurrency" pattern as
   * `SELECT ... FOR UPDATE` used elsewhere in the project (ride
   * acceptance, Phase 9), applied here without an explicit lock: if two
   * requests race to change status from the same starting state, only
   * one UPDATE actually matches a row (rowCount === 1); the loser's
   * WHERE clause matches zero rows because the first request already
   * moved the status elsewhere, so the loser gets a clean "conflict"
   * signal back instead of silently overwriting the winner's change.
   */
  async updateStatusIfCurrentlyIs(
    id: string,
    expectedCurrent: VehicleStatus,
    next: VehicleStatus,
    client?: PoolClient
  ): Promise<VehicleRecord | null> {
    const runner = client ?? pool;
    const { rows } = await runner.query<VehicleRecord>(
      `UPDATE vehicles SET status = $3::vehicle_status, updated_at = now()
       WHERE id = $1 AND status = $2::vehicle_status
       RETURNING *`,
      [id, expectedCurrent, next]
    );
    return rows[0] ?? null;
  },

  async setCurrentDriver(id: string, driverId: string | null, client?: PoolClient): Promise<void> {
    const runner = client ?? pool;
    await runner.query(`UPDATE vehicles SET current_driver_id = $2, updated_at = now() WHERE id = $1`, [
      id,
      driverId,
    ]);
  },

  // --- Owner -> Driver assignments ---

  async findActiveAssignmentByVehicle(vehicleId: string): Promise<AssignmentRecord | null> {
    const { rows } = await pool.query<AssignmentRecord>(
      `SELECT * FROM vehicle_driver_assignments WHERE vehicle_id = $1 AND status = 'ACTIVE'`,
      [vehicleId]
    );
    return rows[0] ?? null;
  },

  async findActiveAssignmentByDriver(driverId: string): Promise<AssignmentRecord | null> {
    const { rows } = await pool.query<AssignmentRecord>(
      `SELECT * FROM vehicle_driver_assignments WHERE driver_id = $1 AND status = 'ACTIVE'`,
      [driverId]
    );
    return rows[0] ?? null;
  },

  /**
   * Creates the assignment and updates both sides of the relationship
   * (vehicle.current_driver_id, driver.current_vehicle_id) atomically.
   * The DB's partial unique index (`..._one_active_per_vehicle`, Phase 3)
   * is the actual, unbypassable guarantee that a vehicle can't end up
   * with two concurrent active assignments even if this application-level
   * check races - the transaction is defense in depth, not the only line
   * of defense.
   */
  async createAssignment(input: {
    vehicleId: string;
    driverId: string;
    ownerId: string;
    commissionPercent: number;
    ownerSharePercent: number;
  }): Promise<AssignmentRecord> {
    return withTransaction(async (client) => {
      const { rows } = await client.query<AssignmentRecord>(
        `INSERT INTO vehicle_driver_assignments (vehicle_id, driver_id, owner_id, commission_percent, owner_share_percent)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [input.vehicleId, input.driverId, input.ownerId, input.commissionPercent, input.ownerSharePercent]
      );
      await client.query(`UPDATE vehicles SET current_driver_id = $2, updated_at = now() WHERE id = $1`, [
        input.vehicleId,
        input.driverId,
      ]);
      await client.query(`UPDATE drivers SET current_vehicle_id = $2, updated_at = now() WHERE user_id = $1`, [
        input.driverId,
        input.vehicleId,
      ]);
      return rows[0];
    });
  },

  async endAssignment(assignmentId: string, vehicleId: string, driverId: string): Promise<void> {
    return withTransaction(async (client) => {
      await client.query(
        `UPDATE vehicle_driver_assignments SET status = 'ENDED', ended_at = now() WHERE id = $1`,
        [assignmentId]
      );
      await client.query(`UPDATE vehicles SET current_driver_id = NULL, updated_at = now() WHERE id = $1`, [
        vehicleId,
      ]);
      await client.query(`UPDATE drivers SET current_vehicle_id = NULL, updated_at = now() WHERE user_id = $1`, [
        driverId,
      ]);
    });
  },
};

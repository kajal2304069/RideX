import { pool, withTransaction } from "../../../db/pool";
import { BookingRecord, BookingStatus, MaintenanceRecordRow, PartUsed, RepairOrderRecord } from "../types/repairs.types";

const BOOKING_SELECT = `
  SELECT b.id, b.garage_id, b.customer_id, b.vehicle_id, b.garage_service_id, b.mechanic_id, b.status,
         b.is_emergency, b.scheduled_at, b.idempotency_key, b.description,
         ST_Y(b.breakdown_location::geometry) AS breakdown_lat, ST_X(b.breakdown_location::geometry) AS breakdown_lng,
         b.created_at, b.updated_at, g.owner_id AS garage_owner_id, g.name AS garage_name
  FROM service_bookings b JOIN garages g ON g.id = b.garage_id`;

const ORDER_COLUMNS = `id, service_booking_id, diagnosis, work_performed, parts_used, labor_cost, parts_cost, total_cost, started_at, completed_at`;

export const repairsRepository = {
  async findById(id: string): Promise<BookingRecord | null> {
    const { rows } = await pool.query<BookingRecord>(`${BOOKING_SELECT} WHERE b.id = $1`, [id]);
    return rows[0] ?? null;
  },

  async findByIdempotencyKey(key: string): Promise<BookingRecord | null> {
    const { rows } = await pool.query<BookingRecord>(`${BOOKING_SELECT} WHERE b.idempotency_key = $1`, [key]);
    return rows[0] ?? null;
  },

  async create(input: {
    garageId: string; customerId: string; vehicleId?: string; garageServiceId?: string; isEmergency: boolean;
    scheduledAt?: Date; idempotencyKey: string; description?: string; breakdown?: { lat: number; lng: number };
  }): Promise<BookingRecord> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO service_bookings
         (garage_id, customer_id, vehicle_id, garage_service_id, is_emergency, scheduled_at, idempotency_key, description, breakdown_location)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               CASE WHEN $9::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($10, $9), 4326)::geography END)
       RETURNING id`,
      [input.garageId, input.customerId, input.vehicleId ?? null, input.garageServiceId ?? null, input.isEmergency,
       input.scheduledAt ?? null, input.idempotencyKey, input.description ?? null,
       input.breakdown?.lat ?? null, input.breakdown?.lng ?? null]
    );
    return (await this.findById(rows[0].id))!;
  },

  async listByCustomer(customerId: string, limit = 50): Promise<BookingRecord[]> {
    const { rows } = await pool.query<BookingRecord>(`${BOOKING_SELECT} WHERE b.customer_id = $1 ORDER BY b.created_at DESC LIMIT $2`, [customerId, limit]);
    return rows;
  },

  async listByGarage(garageId: string, status?: BookingStatus, limit = 100): Promise<BookingRecord[]> {
    const { rows } = await pool.query<BookingRecord>(
      `${BOOKING_SELECT} WHERE b.garage_id = $1 AND ($2::service_booking_status IS NULL OR b.status = $2::service_booking_status)
       ORDER BY b.is_emergency DESC, b.created_at DESC LIMIT $3`,
      [garageId, status ?? null, limit]
    );
    return rows;
  },

  /**
   * Guarded transition: moves the booking only if it is STILL in `from`.
   * Returns null if somebody else moved it first (customer cancelled while
   * the garage accepted, double click, retry). A stale writer can never
   * overwrite a newer state. A unique-violation (mechanic already busy)
   * propagates as a pg 23505 for the service to translate.
   */
  async transition(id: string, from: BookingStatus, to: BookingStatus, extra: { mechanicId?: string } = {}): Promise<BookingRecord | null> {
    const { rowCount } = await pool.query(
      `UPDATE service_bookings
       SET status = $3::service_booking_status, mechanic_id = COALESCE($4, mechanic_id), updated_at = now()
       WHERE id = $1 AND status = $2::service_booking_status`,
      [id, from, to, extra.mechanicId ?? null]
    );
    return rowCount ? this.findById(id) : null;
  },

  async findRepairOrder(bookingId: string): Promise<RepairOrderRecord | null> {
    const { rows } = await pool.query<RepairOrderRecord>(`SELECT ${ORDER_COLUMNS} FROM repair_orders WHERE service_booking_id = $1`, [bookingId]);
    return rows[0] ?? null;
  },

  async ensureRepairOrder(bookingId: string): Promise<void> {
    await pool.query(
      `INSERT INTO repair_orders (service_booking_id, started_at) VALUES ($1, now()) ON CONFLICT (service_booking_id) DO NOTHING`,
      [bookingId]
    );
  },

  /**
   * Updates the repair order ONLY while the booking is REPAIR_IN_PROGRESS,
   * in a single statement. Because "is it still in progress?" and "write the
   * costs" are one atomic UPDATE, there is no window in which a concurrent
   * "mark ready" can slip between the check and the write. Once READY the
   * amount is frozen, which is what makes the later payment amount stable.
   */
  async updateRepairOrderIfInProgress(bookingId: string, fields: {
    diagnosis?: string; workPerformed?: string; partsUsed: PartUsed[]; laborCost: number; partsCost: number; totalCost: number;
  }): Promise<RepairOrderRecord | null> {
    const { rows } = await pool.query<RepairOrderRecord>(
      `UPDATE repair_orders ro
       SET diagnosis = COALESCE($2, ro.diagnosis), work_performed = COALESCE($3, ro.work_performed),
           parts_used = $4, labor_cost = $5, parts_cost = $6, total_cost = $7
       FROM service_bookings b
       WHERE ro.service_booking_id = $1 AND b.id = ro.service_booking_id AND b.status = 'REPAIR_IN_PROGRESS'
       RETURNING ro.${ORDER_COLUMNS.split(", ").join(", ro.")}`,
      [bookingId, fields.diagnosis ?? null, fields.workPerformed ?? null, JSON.stringify(fields.partsUsed), fields.laborCost, fields.partsCost, fields.totalCost]
    );
    return rows[0] ?? null;
  },

  /**
   * READY -> COMPLETED, the repair order's completed_at, and the vehicle's
   * maintenance-history entry, all in ONE transaction: either the job is
   * completed AND recorded, or nothing changed. Returns null when the
   * booking was not READY (already completed by an earlier delivery of the
   * payment event), which makes the whole operation idempotent.
   */
  async completeBooking(id: string, nextDueDays: number | null): Promise<BookingRecord | null> {
    const done = await withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE service_bookings SET status = 'COMPLETED', updated_at = now() WHERE id = $1 AND status = 'READY'
         RETURNING vehicle_id, garage_service_id`,
        [id]
      );
      if (!upd.rowCount) return false;

      const { vehicle_id, garage_service_id } = upd.rows[0] as { vehicle_id: string | null; garage_service_id: string | null };
      const order = await client.query(`UPDATE repair_orders SET completed_at = now() WHERE service_booking_id = $1 RETURNING total_cost, diagnosis`, [id]);

      if (vehicle_id) {
        await client.query(
          `INSERT INTO maintenance_records (vehicle_id, service_type, cost, odometer_km, notes, next_due_at)
           SELECT $1, s.service_type, $2, v.mileage_km, $3,
                  CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(days => $4::int) END
           FROM vehicles v LEFT JOIN garage_services s ON s.id = $5
           WHERE v.id = $1`,
          [vehicle_id, order.rows[0]?.total_cost ?? null, order.rows[0]?.diagnosis ?? null, nextDueDays, garage_service_id]
        );
      }
      return true;
    });
    return done ? this.findById(id) : null;
  },

  async listMaintenance(vehicleId: string): Promise<MaintenanceRecordRow[]> {
    const { rows } = await pool.query<MaintenanceRecordRow>(
      `SELECT id, vehicle_id, service_type, cost, odometer_km, performed_at, next_due_at, notes
       FROM maintenance_records WHERE vehicle_id = $1 ORDER BY performed_at DESC`,
      [vehicleId]
    );
    return rows;
  },
};

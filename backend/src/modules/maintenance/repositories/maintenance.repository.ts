import { pool } from "../../../db/pool";

const VEHICLE_TITLE = `(v.year || ' ' || v.brand || ' ' || v.model)`;

export const maintenanceRepository = {
  async vehicleOwner(vehicleId: string): Promise<string | null> {
    const { rows } = await pool.query(`SELECT owner_id FROM vehicles WHERE id = $1`, [vehicleId]);
    return rows[0]?.owner_id ?? null;
  },

  // ---------- records ----------
  async addRecord(vehicleId: string, r: { serviceType: string; cost?: number; odometerKm?: number; performedAt?: Date; notes?: string; nextDueAt: Date | null }) {
    const { rows } = await pool.query(
      `INSERT INTO maintenance_records (vehicle_id, service_type, cost, odometer_km, performed_at, notes, next_due_at, source)
       VALUES ($1, $2::garage_service_type, $3, $4, COALESCE($5, now()), $6, $7, 'OWNER')
       RETURNING id, vehicle_id, service_type::text AS service_type, cost, odometer_km, performed_at, next_due_at, notes, source`,
      [vehicleId, r.serviceType, r.cost ?? null, r.odometerKm ?? null, r.performedAt ?? null, r.notes ?? null, r.nextDueAt]
    );
    return rows[0];
  },
  async records(vehicleId: string) {
    const { rows } = await pool.query(
      `SELECT id, vehicle_id, service_type::text AS service_type, cost, odometer_km, performed_at, next_due_at, notes, source
       FROM maintenance_records WHERE vehicle_id = $1 ORDER BY performed_at DESC, id DESC`, [vehicleId]);
    return rows;
  },
  async costTotal(vehicleId: string): Promise<number> {
    const { rows } = await pool.query(`SELECT COALESCE(SUM(cost),0) AS s FROM maintenance_records WHERE vehicle_id = $1`, [vehicleId]);
    return Number(rows[0].s);
  },

  // ---------- documents ----------
  async addDocument(vehicleId: string, d: { docType: string; documentNumber?: string; issuedAt?: string; expiresAt: string; notes?: string }) {
    const { rows } = await pool.query(
      `INSERT INTO vehicle_documents (vehicle_id, doc_type, document_number, issued_at, expires_at, notes)
       VALUES ($1, $2::vehicle_document_type, $3, $4, $5, $6)
       RETURNING id, vehicle_id, doc_type::text AS doc_type, document_number, issued_at::text AS issued_at, expires_at::text AS expires_at, notes`,
      [vehicleId, d.docType, d.documentNumber ?? null, d.issuedAt ?? null, d.expiresAt, d.notes ?? null]
    );
    return rows[0];
  },
  async documents(vehicleId: string) {
    const { rows } = await pool.query(
      `SELECT id, vehicle_id, doc_type::text AS doc_type, document_number, issued_at::text AS issued_at, expires_at::text AS expires_at, notes
       FROM vehicle_documents WHERE vehicle_id = $1 ORDER BY expires_at DESC, id DESC`, [vehicleId]);
    return rows;
  },
  async deleteDocument(vehicleId: string, id: string): Promise<boolean> {
    const { rowCount } = await pool.query(`DELETE FROM vehicle_documents WHERE id = $1 AND vehicle_id = $2`, [id, vehicleId]);
    return (rowCount ?? 0) > 0;
  },

  // ---------- incidents ----------
  async addIncident(vehicleId: string, i: { occurredAt: string; severity: string; description: string; repairCost?: number }) {
    const { rows } = await pool.query(
      `INSERT INTO vehicle_incidents (vehicle_id, occurred_at, severity, description, repair_cost) VALUES ($1, $2, $3::incident_severity, $4, $5)
       RETURNING id, vehicle_id, occurred_at::text AS occurred_at, severity::text AS severity, description, repair_cost`,
      [vehicleId, i.occurredAt, i.severity, i.description, i.repairCost ?? null]
    );
    return rows[0];
  },
  async incidents(vehicleId: string) {
    const { rows } = await pool.query(
      `SELECT id, vehicle_id, occurred_at::text AS occurred_at, severity::text AS severity, description, repair_cost
       FROM vehicle_incidents WHERE vehicle_id = $1 ORDER BY occurred_at DESC, id DESC`, [vehicleId]);
    return rows;
  },

  // ---------- reminder scans ----------
  /**
   * The LATEST record per (vehicle, service type) that has a schedule. A newer service supersedes an older one, so a
   * serviced vehicle stops being "overdue" the moment the new record exists. `ownerId` narrows to one owner's fleet.
   */
  async dueServices(horizon: Date, ownerId?: string) {
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (m.vehicle_id, m.service_type)
                m.id, m.vehicle_id, m.service_type::text AS service_type, m.next_due_at, m.performed_at,
                v.owner_id, v.current_driver_id, ${VEHICLE_TITLE} AS vehicle_title
         FROM maintenance_records m JOIN vehicles v ON v.id = m.vehicle_id
         WHERE ($2::uuid IS NULL OR v.owner_id = $2)
         ORDER BY m.vehicle_id, m.service_type, m.performed_at DESC, m.id DESC
       ) latest
       WHERE next_due_at IS NOT NULL AND next_due_at <= $1
       ORDER BY next_due_at`,
      [horizon, ownerId ?? null]
    );
    return rows;
  },

  /** The LATEST document per (vehicle, type) that expires on or before `horizonDay`; a renewal supersedes the old one. */
  async expiringDocuments(horizonDay: string, earliestDay: string, ownerId?: string) {
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (d.vehicle_id, d.doc_type)
                d.id, d.vehicle_id, d.doc_type::text AS doc_type, d.expires_at::text AS expires_at,
                v.owner_id, v.current_driver_id, ${VEHICLE_TITLE} AS vehicle_title
         FROM vehicle_documents d JOIN vehicles v ON v.id = d.vehicle_id
         WHERE ($3::uuid IS NULL OR v.owner_id = $3)
         ORDER BY d.vehicle_id, d.doc_type, d.expires_at DESC, d.id DESC
       ) latest
       WHERE expires_at::date <= $1::date AND expires_at::date >= $2::date
       ORDER BY expires_at`,
      [horizonDay, earliestDay, ownerId ?? null]
    );
    return rows;
  },
};

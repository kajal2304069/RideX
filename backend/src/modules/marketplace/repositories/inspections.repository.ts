import { pool } from "../../../db/pool";
import { InspectionRecord, InspectionReport } from "../types/marketplace.types";

const SELECT = `
  SELECT i.id, i.listing_id, i.buyer_id, i.inspector_id, i.scheduled_at, i.status, i.report, i.created_at, l.seller_id
  FROM vehicle_inspections i JOIN vehicle_listings l ON l.id = i.listing_id`;

export const inspectionsRepository = {
  async findById(id: string): Promise<InspectionRecord | null> {
    const { rows } = await pool.query<InspectionRecord>(`${SELECT} WHERE i.id = $1`, [id]);
    return rows[0] ?? null;
  },

  /** Throws pg 23505 if this buyer already has a SCHEDULED inspection for the listing. */
  async create(listingId: string, buyerId: string, scheduledAt: Date): Promise<InspectionRecord> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO vehicle_inspections (listing_id, buyer_id, scheduled_at) VALUES ($1, $2, $3) RETURNING id`,
      [listingId, buyerId, scheduledAt]
    );
    return (await this.findById(rows[0].id))!;
  },

  async listForBuyer(buyerId: string): Promise<InspectionRecord[]> {
    const { rows } = await pool.query<InspectionRecord>(`${SELECT} WHERE i.buyer_id = $1 ORDER BY i.scheduled_at DESC`, [buyerId]);
    return rows;
  },

  async listForListing(listingId: string): Promise<InspectionRecord[]> {
    const { rows } = await pool.query<InspectionRecord>(`${SELECT} WHERE i.listing_id = $1 ORDER BY i.scheduled_at DESC`, [listingId]);
    return rows;
  },

  /** What a mechanic can pick up: scheduled, in the future-or-today, on a listing that is still for sale. */
  async listOpen(limit = 50): Promise<InspectionRecord[]> {
    const { rows } = await pool.query<InspectionRecord>(
      `${SELECT} WHERE i.status = 'SCHEDULED' AND l.status = 'ACTIVE' ORDER BY i.scheduled_at ASC LIMIT $1`,
      [limit]
    );
    return rows;
  },

  /** Guarded: only a SCHEDULED inspection can be completed, so two mechanics cannot both submit a report. */
  async complete(id: string, inspectorId: string, report: InspectionReport): Promise<InspectionRecord | null> {
    const { rowCount } = await pool.query(
      `UPDATE vehicle_inspections SET status = 'COMPLETED', inspector_id = $2, report = $3 WHERE id = $1 AND status = 'SCHEDULED'`,
      [id, inspectorId, JSON.stringify(report)]
    );
    return rowCount ? this.findById(id) : null;
  },

  async cancel(id: string): Promise<boolean> {
    const { rowCount } = await pool.query(`UPDATE vehicle_inspections SET status = 'CANCELLED' WHERE id = $1 AND status = 'SCHEDULED'`, [id]);
    return (rowCount ?? 0) > 0;
  },
};

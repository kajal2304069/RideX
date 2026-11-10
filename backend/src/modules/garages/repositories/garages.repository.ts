import { pool } from "../../../db/pool";
import { GarageRecord, GarageServiceRecord, GarageServiceType, MechanicRecord } from "../types/garages.types";

/** `location` is geography(Point); ST_Y/ST_X give plain lat/lng so upper layers never see PostGIS. */
const GARAGE_COLUMNS = `g.id, g.owner_id, g.name, ST_Y(g.location::geometry) AS lat, ST_X(g.location::geometry) AS lng,
  g.address, g.phone, g.opening_hours, g.price_range, g.rating_avg, g.is_active, g.created_at, g.updated_at`;

export const garagesRepository = {
  async create(input: {
    ownerId: string; name: string; lat: number; lng: number; address: string;
    phone?: string; openingHours?: Record<string, string>; priceRange?: string;
  }): Promise<GarageRecord> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO garages (owner_id, name, location, address, phone, opening_hours, price_range)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $5, $6, $7, $8)
       RETURNING id`,
      [input.ownerId, input.name, input.lat, input.lng, input.address, input.phone ?? null,
       input.openingHours ? JSON.stringify(input.openingHours) : null, input.priceRange ?? null]
    );
    return (await this.findById(rows[0].id))!;
  },

  async findById(id: string): Promise<GarageRecord | null> {
    const { rows } = await pool.query<GarageRecord>(`SELECT ${GARAGE_COLUMNS} FROM garages g WHERE g.id = $1`, [id]);
    return rows[0] ?? null;
  },

  async findByOwner(ownerId: string): Promise<GarageRecord[]> {
    const { rows } = await pool.query<GarageRecord>(
      `SELECT ${GARAGE_COLUMNS} FROM garages g WHERE g.owner_id = $1 ORDER BY g.created_at DESC`,
      [ownerId]
    );
    return rows;
  },

  async update(id: string, patch: {
    name?: string; address?: string; phone?: string | null; openingHours?: Record<string, string> | null;
    priceRange?: string | null; isActive?: boolean; lat?: number; lng?: number;
  }): Promise<GarageRecord | null> {
    const sets: string[] = ["updated_at = now()"];
    const values: unknown[] = [id];
    const add = (sql: string, v: unknown) => { values.push(v); sets.push(sql.replace("?", `$${values.length}`)); };

    if (patch.name !== undefined) add("name = ?", patch.name);
    if (patch.address !== undefined) add("address = ?", patch.address);
    if (patch.phone !== undefined) add("phone = ?", patch.phone);
    if (patch.openingHours !== undefined) add("opening_hours = ?", patch.openingHours === null ? null : JSON.stringify(patch.openingHours));
    if (patch.priceRange !== undefined) add("price_range = ?", patch.priceRange);
    if (patch.isActive !== undefined) add("is_active = ?", patch.isActive);
    if (patch.lat !== undefined && patch.lng !== undefined) {
      values.push(patch.lng, patch.lat);
      sets.push(`location = ST_SetSRID(ST_MakePoint($${values.length - 1}, $${values.length}), 4326)::geography`);
    }

    await pool.query(`UPDATE garages SET ${sets.join(", ")} WHERE id = $1`, values);
    return this.findById(id);
  },

  /**
   * Nearby search. Two PostGIS ideas working together:
   *   ST_DWithin  - filter: uses the GIST index to discard everything outside the radius
   *   <->         - KNN operator: orders by distance using the same index
   * Distance is computed once more in the SELECT list only for the rows that survive.
   */
  async findNearby(input: { lat: number; lng: number; radiusMeters: number; serviceType?: GarageServiceType; limit: number }): Promise<GarageRecord[]> {
    const { rows } = await pool.query<GarageRecord>(
      `SELECT ${GARAGE_COLUMNS},
              ST_Distance(g.location, p.pt) AS distance_meters,
              COALESCE((SELECT array_agg(s.service_type::text ORDER BY s.service_type::text) FROM garage_services s WHERE s.garage_id = g.id), ARRAY[]::text[]) AS service_types
       FROM garages g, (SELECT ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography AS pt) p
       WHERE g.is_active = true
         AND ST_DWithin(g.location, p.pt, $3)
         AND ($4::garage_service_type IS NULL
              OR EXISTS (SELECT 1 FROM garage_services s WHERE s.garage_id = g.id AND s.service_type = $4::garage_service_type))
       ORDER BY g.location <-> p.pt
       LIMIT $5`,
      [input.lat, input.lng, input.radiusMeters, input.serviceType ?? null, input.limit]
    );
    return rows;
  },

  // --- services ---
  async addService(garageId: string, input: { serviceType: GarageServiceType; priceFrom?: number; priceTo?: number; estimatedDurationMinutes?: number }): Promise<GarageServiceRecord> {
    const { rows } = await pool.query<GarageServiceRecord>(
      `INSERT INTO garage_services (garage_id, service_type, price_from, price_to, estimated_duration_minutes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, garage_id, service_type, price_from, price_to, estimated_duration_minutes`,
      [garageId, input.serviceType, input.priceFrom ?? null, input.priceTo ?? null, input.estimatedDurationMinutes ?? null]
    );
    return rows[0];
  },

  async listServices(garageId: string): Promise<GarageServiceRecord[]> {
    const { rows } = await pool.query<GarageServiceRecord>(
      `SELECT id, garage_id, service_type, price_from, price_to, estimated_duration_minutes
       FROM garage_services WHERE garage_id = $1 ORDER BY service_type::text`,
      [garageId]
    );
    return rows;
  },

  async findService(serviceId: string): Promise<GarageServiceRecord | null> {
    const { rows } = await pool.query<GarageServiceRecord>(
      `SELECT id, garage_id, service_type, price_from, price_to, estimated_duration_minutes FROM garage_services WHERE id = $1`,
      [serviceId]
    );
    return rows[0] ?? null;
  },

  async findServiceByType(garageId: string, type: GarageServiceType): Promise<GarageServiceRecord | null> {
    const { rows } = await pool.query<GarageServiceRecord>(
      `SELECT id, garage_id, service_type, price_from, price_to, estimated_duration_minutes FROM garage_services WHERE garage_id = $1 AND service_type = $2`,
      [garageId, type]
    );
    return rows[0] ?? null;
  },

  async deleteService(garageId: string, serviceId: string): Promise<boolean> {
    const { rowCount } = await pool.query(`DELETE FROM garage_services WHERE id = $1 AND garage_id = $2`, [serviceId, garageId]);
    return (rowCount ?? 0) > 0;
  },

  // --- mechanics ---
  async addMechanic(garageId: string, input: { name: string; specialization?: string; userId?: string }): Promise<MechanicRecord> {
    const { rows } = await pool.query<MechanicRecord>(
      `INSERT INTO mechanics (garage_id, name, specialization, user_id) VALUES ($1, $2, $3, $4)
       RETURNING id, garage_id, user_id, name, specialization, is_active`,
      [garageId, input.name, input.specialization ?? null, input.userId ?? null]
    );
    return rows[0];
  },

  async listMechanics(garageId: string): Promise<MechanicRecord[]> {
    const { rows } = await pool.query<MechanicRecord>(
      `SELECT id, garage_id, user_id, name, specialization, is_active FROM mechanics WHERE garage_id = $1 ORDER BY created_at`,
      [garageId]
    );
    return rows;
  },

  async findMechanic(mechanicId: string): Promise<MechanicRecord | null> {
    const { rows } = await pool.query<MechanicRecord>(
      `SELECT id, garage_id, user_id, name, specialization, is_active FROM mechanics WHERE id = $1`,
      [mechanicId]
    );
    return rows[0] ?? null;
  },

  async setMechanicActive(mechanicId: string, active: boolean): Promise<MechanicRecord | null> {
    const { rows } = await pool.query<MechanicRecord>(
      `UPDATE mechanics SET is_active = $2 WHERE id = $1 RETURNING id, garage_id, user_id, name, specialization, is_active`,
      [mechanicId, active]
    );
    return rows[0] ?? null;
  },

  async mechanicHasActiveJob(mechanicId: string): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT 1 FROM service_bookings WHERE mechanic_id = $1 AND status IN ('MECHANIC_ASSIGNED','VEHICLE_RECEIVED','REPAIR_IN_PROGRESS') LIMIT 1`,
      [mechanicId]
    );
    return rows.length > 0;
  },
};

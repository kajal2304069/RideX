import { pool } from "../../../db/pool";
import { RentalListingRecord } from "../types/rentals.types";

export type RentalSortKey = "newest" | "price_asc" | "distance";

export interface RentalSearchFilters {
  q?: string;
  vehicleTypeId?: string;
  fuelType?: string;
  transmission?: string;
  /** Price per day ("from" price): the daily price, or 24 x hourly when only hourly is set. */
  minDailyPrice?: number;
  maxDailyPrice?: number;
  near?: { lat: number; lng: number; radiusMeters: number };
  /** Only listings free for the WHOLE window. */
  availableFrom?: Date;
  availableTo?: Date;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const LISTING_SELECT = `
  SELECT l.id, l.owner_id, u.full_name AS owner_name, l.vehicle_id, v.vehicle_type_id, v.brand, v.model, v.year,
         v.fuel_type::text AS fuel_type, v.transmission::text AS transmission,
         l.hourly_price, l.daily_price, l.security_deposit,
         ST_Y(l.pickup_location::geometry) AS lat, ST_X(l.pickup_location::geometry) AS lng,
         l.pickup_address, l.rules, l.is_active, l.created_at, l.updated_at
  FROM rental_listings l
  JOIN vehicles v ON v.id = l.vehicle_id
  JOIN users u ON u.id = l.owner_id`;

export const rentalListingsRepository = {
  async findById(id: string): Promise<RentalListingRecord | null> {
    const { rows } = await pool.query<RentalListingRecord>(`${LISTING_SELECT} WHERE l.id = $1`, [id]);
    return rows[0] ?? null;
  },

  /** RIDE | RENTAL | BOTH. A RIDE-only type (say an auto-rickshaw) cannot be put up for rent. */
  async vehicleTypeCategory(vehicleTypeId: string): Promise<string | null> {
    const { rows } = await pool.query<{ category: string }>(`SELECT category FROM vehicle_types WHERE id = $1`, [vehicleTypeId]);
    return rows[0]?.category ?? null;
  },

  async findByVehicle(vehicleId: string): Promise<RentalListingRecord | null> {
    const { rows } = await pool.query<RentalListingRecord>(`${LISTING_SELECT} WHERE l.vehicle_id = $1`, [vehicleId]);
    return rows[0] ?? null;
  },

  async listByOwner(ownerId: string): Promise<RentalListingRecord[]> {
    const { rows } = await pool.query<RentalListingRecord>(`${LISTING_SELECT} WHERE l.owner_id = $1 ORDER BY l.created_at DESC, l.id DESC`, [ownerId]);
    return rows;
  },

  /** Throws pg 23505 (vehicle already listed) or 23503 (vehicle missing, or not owned by owner: composite FK). */
  async create(input: {
    ownerId: string; vehicleId: string; hourlyPrice: number | null; dailyPrice: number | null; securityDeposit: number;
    lat: number; lng: number; address?: string; rules?: string;
  }): Promise<RentalListingRecord> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO rental_listings (owner_id, vehicle_id, hourly_price, daily_price, security_deposit, pickup_location, pickup_address, rules)
       VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_MakePoint($7, $6), 4326)::geography, $8, $9)
       RETURNING id`,
      [input.ownerId, input.vehicleId, input.hourlyPrice, input.dailyPrice, input.securityDeposit, input.lat, input.lng, input.address ?? null, input.rules ?? null]
    );
    return (await this.findById(rows[0].id))!;
  },

  async update(id: string, f: {
    hourlyPrice?: number | null; dailyPrice?: number | null; securityDeposit?: number; lat?: number; lng?: number;
    address?: string | null; rules?: string | null;
  }): Promise<RentalListingRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (f.hourlyPrice !== undefined) sets.push(`hourly_price = ${p(f.hourlyPrice)}`);
    if (f.dailyPrice !== undefined) sets.push(`daily_price = ${p(f.dailyPrice)}`);
    if (f.securityDeposit !== undefined) sets.push(`security_deposit = ${p(f.securityDeposit)}`);
    if (f.lat !== undefined && f.lng !== undefined) sets.push(`pickup_location = ST_SetSRID(ST_MakePoint(${p(f.lng)}, ${p(f.lat)}), 4326)::geography`);
    if (f.address !== undefined) sets.push(`pickup_address = ${p(f.address)}`);
    if (f.rules !== undefined) sets.push(`rules = ${p(f.rules)}`);
    if (sets.length) await pool.query(`UPDATE rental_listings SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
    return this.findById(id);
  },

  async setActive(id: string, active: boolean): Promise<RentalListingRecord | null> {
    await pool.query(`UPDATE rental_listings SET is_active = $2, updated_at = now() WHERE id = $1`, [id, active]);
    return this.findById(id);
  },

  async search(input: { filters: RentalSearchFilters; sort: RentalSortKey; cursor?: { v: string; id: string }; limit: number }): Promise<RentalListingRecord[]> {
    const { filters: f } = input;
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where: string[] = [`l.is_active`];
    const dailyExpr = `COALESCE(l.daily_price, l.hourly_price * 24)`;

    if (f.q) where.push(`(v.brand || ' ' || v.model) ILIKE ${p(`%${escapeLike(f.q)}%`)}`);
    if (f.vehicleTypeId) where.push(`v.vehicle_type_id = ${p(f.vehicleTypeId)}`);
    if (f.fuelType) where.push(`v.fuel_type = ${p(f.fuelType)}::fuel_type`);
    if (f.transmission) where.push(`v.transmission = ${p(f.transmission)}::transmission_type`);
    if (f.minDailyPrice !== undefined) where.push(`${dailyExpr} >= ${p(f.minDailyPrice)}`);
    if (f.maxDailyPrice !== undefined) where.push(`${dailyExpr} <= ${p(f.maxDailyPrice)}`);

    let distanceExpr = "NULL::float8";
    if (f.near) {
      const pt = `ST_SetSRID(ST_MakePoint(${p(f.near.lng)}, ${p(f.near.lat)}), 4326)::geography`;
      distanceExpr = `ST_Distance(l.pickup_location, ${pt})`;
      where.push(`ST_DWithin(l.pickup_location, ${pt}, ${p(f.near.radiusMeters)})`);
    }
    if (f.availableFrom && f.availableTo) {
      // Same predicate as the exclusion constraint, except a PENDING_PAYMENT hold only counts while it is still live.
      where.push(`NOT EXISTS (
        SELECT 1 FROM rental_bookings b
        WHERE b.rental_listing_id = l.id
          AND (b.status IN ('CONFIRMED', 'ACTIVE') OR (b.status = 'PENDING_PAYMENT' AND b.payment_due_at > now()))
          AND tstzrange(b.start_at, b.end_at, '[)') && tstzrange(${p(f.availableFrom)}::timestamptz, ${p(f.availableTo)}::timestamptz, '[)'))`);
    }

    const sorts: Record<RentalSortKey, { expr: string; dir: "ASC" | "DESC"; cast: string }> = {
      newest: { expr: "l.created_at", dir: "DESC", cast: "timestamptz" },
      price_asc: { expr: dailyExpr, dir: "ASC", cast: "numeric" },
      distance: { expr: distanceExpr, dir: "ASC", cast: "float8" },
    };
    const s = sorts[input.sort];
    if (input.cursor) {
      const op = s.dir === "ASC" ? ">" : "<";
      where.push(`(${s.expr}, l.id) ${op} (${p(input.cursor.v)}::${s.cast}, ${p(input.cursor.id)}::uuid)`);
    }

    const { rows } = await pool.query<RentalListingRecord>(
      `SELECT x.* FROM (
         SELECT l.id, l.owner_id, u.full_name AS owner_name, l.vehicle_id, v.vehicle_type_id, v.brand, v.model, v.year,
                v.fuel_type::text AS fuel_type, v.transmission::text AS transmission,
                l.hourly_price, l.daily_price, l.security_deposit,
                ST_Y(l.pickup_location::geometry) AS lat, ST_X(l.pickup_location::geometry) AS lng,
                l.pickup_address, l.rules, l.is_active, l.created_at, l.updated_at,
                ${distanceExpr} AS distance_meters,
                (${s.expr})::text AS sort_value
         FROM rental_listings l JOIN vehicles v ON v.id = l.vehicle_id JOIN users u ON u.id = l.owner_id
         WHERE ${where.join(" AND ")}
         ORDER BY ${s.expr} ${s.dir}, l.id ${s.dir}
         LIMIT ${p(input.limit)}
       ) x`,
      params
    );
    return rows;
  },
};

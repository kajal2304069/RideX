import { PoolClient } from "pg";
import { pool, withTransaction } from "../../../db/pool";
import { RideRecord, RideStatus, FareBreakdown } from "../types/rides.types";

/**
 * Every SELECT lists columns explicitly (rather than `SELECT *`) so
 * pickup/dropoff - stored as PostGIS `geography(Point,4326)` per Phase
 * 3 - come back as plain `pickup_lat`/`pickup_lng` numbers via
 * ST_Y/ST_X, matching RideRecord's shape. The service/controller layers
 * never need to know PostGIS is involved at all.
 */
const RIDE_COLUMNS = `
  id, rider_id, driver_id, vehicle_id, vehicle_type_id, status,
  ST_Y(pickup_location::geometry) AS pickup_lat,
  ST_X(pickup_location::geometry) AS pickup_lng,
  pickup_address,
  ST_Y(dropoff_location::geometry) AS dropoff_lat,
  ST_X(dropoff_location::geometry) AS dropoff_lng,
  dropoff_address,
  idempotency_key, distance_meters, duration_seconds,
  requested_at, accepted_at, arrived_at, started_at, completed_at, cancelled_at, cancellation_reason,
  surge_multiplier::text AS surge_multiplier,
  created_at, updated_at
`;

export const ridesRepository = {
  /** What the other party on a ride needs to recognise the driver: name, rating, the car and its plate. */
  async findDriverCard(driverId: string, vehicleId: string | null) {
    const { rows } = await pool.query<{ full_name: string; phone: string | null; rating_avg: string; total_rides: number; brand: string | null; model: string | null; color: string | null; registration_number: string | null; type_name: string | null; type_code: string | null }>(
      `SELECT u.full_name, u.phone, d.rating_avg, d.total_rides, v.brand, v.model, v.color, v.registration_number, vt.display_name AS type_name, vt.code AS type_code
       FROM drivers d JOIN users u ON u.id = d.user_id
       LEFT JOIN vehicles v ON v.id = $2 LEFT JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
       WHERE d.user_id = $1`, [driverId, vehicleId]);
    return rows[0] ?? null;
  },

  async findRiderCard(riderId: string) {
    const { rows } = await pool.query<{ full_name: string; phone: string | null }>(`SELECT full_name, phone FROM users WHERE id = $1`, [riderId]);
    return rows[0] ?? null;
  },

  /** Inserts a rating and refreshes the ratee's average atomically. Returns false if this rater already rated the ride. */
  async addRating(input: { rideId: string; raterId: string; rateeId: string; rating: number; comment?: string; rateeIsDriver: boolean }): Promise<boolean> {
    return withTransaction(async (client) => {
      const ins = await client.query(
        `INSERT INTO ratings (ride_id, rater_id, ratee_id, rating, comment) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (ride_id, rater_id) DO NOTHING RETURNING id`,
        [input.rideId, input.raterId, input.rateeId, input.rating, input.comment ?? null]
      );
      if (!ins.rowCount) return false;
      const table = input.rateeIsDriver ? "drivers" : "riders";
      await client.query(
        `UPDATE ${table} SET rating_avg = (SELECT ROUND(AVG(rating)::numeric, 2) FROM ratings WHERE ratee_id = $1), updated_at = now() WHERE user_id = $1`,
        [input.rateeId]
      );
      return true;
    });
  },

  async findRatingBy(rideId: string, raterId: string): Promise<number | null> {
    const { rows } = await pool.query<{ rating: number }>(`SELECT rating FROM ratings WHERE ride_id = $1 AND rater_id = $2`, [rideId, raterId]);
    return rows[0]?.rating ?? null;
  },

  async findById(id: string, client?: PoolClient): Promise<RideRecord | null> {
    const runner = client ?? pool;
    const { rows } = await runner.query<RideRecord>(`SELECT ${RIDE_COLUMNS} FROM rides WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },

  async findByIdempotencyKey(key: string): Promise<RideRecord | null> {
    const { rows } = await pool.query<RideRecord>(`SELECT ${RIDE_COLUMNS} FROM rides WHERE idempotency_key = $1`, [
      key,
    ]);
    return rows[0] ?? null;
  },

  /** A rider's currently-active (non-terminal) ride, if any - used to prevent requesting a second ride while one is already in flight. */
  async findActiveByRider(riderId: string): Promise<RideRecord | null> {
    const { rows } = await pool.query<RideRecord>(
      `SELECT ${RIDE_COLUMNS} FROM rides
       WHERE rider_id = $1
         AND status NOT IN ('PAYMENT_COMPLETED','CANCELLED_BY_RIDER','CANCELLED_BY_DRIVER','CANCELLED_BY_SYSTEM')
       ORDER BY requested_at DESC
       LIMIT 1`,
      [riderId]
    );
    return rows[0] ?? null;
  },

  async findActiveByDriver(driverId: string): Promise<RideRecord | null> {
    const { rows } = await pool.query<RideRecord>(
      `SELECT ${RIDE_COLUMNS} FROM rides
       WHERE driver_id = $1
         AND status NOT IN ('PAYMENT_COMPLETED','CANCELLED_BY_RIDER','CANCELLED_BY_DRIVER','CANCELLED_BY_SYSTEM')
       ORDER BY requested_at DESC
       LIMIT 1`,
      [driverId]
    );
    return rows[0] ?? null;
  },

  async findHistoryByRider(riderId: string, limit = 20): Promise<RideRecord[]> {
    const { rows } = await pool.query<RideRecord>(
      `SELECT ${RIDE_COLUMNS} FROM rides WHERE rider_id = $1 ORDER BY requested_at DESC LIMIT $2`,
      [riderId, limit]
    );
    return rows;
  },

  /** Rides currently open for driver acceptance - the crude "matching pool" until Phase 9's real MatchingService exists. */
  async findSearchingRides(vehicleTypeId?: string): Promise<RideRecord[]> {
    const { rows } = await pool.query<RideRecord>(
      vehicleTypeId
        ? `SELECT ${RIDE_COLUMNS} FROM rides WHERE status = 'SEARCHING_DRIVER' AND vehicle_type_id = $1 ORDER BY requested_at ASC`
        : `SELECT ${RIDE_COLUMNS} FROM rides WHERE status = 'SEARCHING_DRIVER' ORDER BY requested_at ASC`,
      vehicleTypeId ? [vehicleTypeId] : []
    );
    return rows;
  },

  /** Open (SEARCHING_DRIVER) requests of this vehicle type within `radiusMeters` of a point: the "demand" in surge pricing. */
  async countSearchingNear(point: { lat: number; lng: number }, vehicleTypeId: string, radiusMeters: number): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM rides
       WHERE status = 'SEARCHING_DRIVER' AND vehicle_type_id = $1
         AND ST_DWithin(pickup_location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)`,
      [vehicleTypeId, point.lng, point.lat, radiusMeters]
    );
    return Number(rows[0].n);
  },

  async create(input: {
    riderId: string;
    vehicleTypeId: string;
    pickup: { lat: number; lng: number; address: string };
    dropoff: { lat: number; lng: number; address: string };
    idempotencyKey: string;
    distanceMeters: number;
    durationSeconds: number;
    surgeMultiplier?: number;
  }): Promise<RideRecord> {
    const { rows } = await pool.query<RideRecord>(
      `INSERT INTO rides (
         rider_id, vehicle_type_id, status,
         pickup_location, pickup_address,
         dropoff_location, dropoff_address,
         idempotency_key, distance_meters, duration_seconds, surge_multiplier
       ) VALUES (
         $1, $2, 'SEARCHING_DRIVER',
         ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5,
         ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography, $8,
         $9, $10, $11, $12
       )
       RETURNING id`,
      [
        input.riderId,
        input.vehicleTypeId,
        input.pickup.lng,
        input.pickup.lat,
        input.pickup.address,
        input.dropoff.lng,
        input.dropoff.lat,
        input.dropoff.address,
        input.idempotencyKey,
        input.distanceMeters,
        input.durationSeconds,
        input.surgeMultiplier ?? 1.0,
      ]
    );
    return (await this.findById(rows[0].id))!;
  },

  /**
   * THE concurrency-critical operation (spec section 12's exact
   * scenario: three drivers accept the same ride, only one must win).
   *
   * `SELECT ... FOR UPDATE` takes a row-level lock on the ride for the
   * duration of this transaction. If two `acceptRide` calls run
   * concurrently for the same ride:
   *   - Transaction A's SELECT FOR UPDATE acquires the lock immediately.
   *   - Transaction B's SELECT FOR UPDATE BLOCKS until A commits/rolls back.
   *   - A checks status === SEARCHING_DRIVER (true), assigns itself, commits.
   *   - B's SELECT FOR UPDATE now proceeds, re-reads the row - status is
   *     now DRIVER_ASSIGNED, not SEARCHING_DRIVER - so B's check fails
   *     and it throws, WITHOUT ever having raced A on the actual write.
   *
   * This is pessimistic locking (contrast with Phase 5's optimistic
   * `WHERE status = $expected` approach) - the right tool here because
   * ride acceptance is exactly the kind of high-contention, must-not-
   * double-assign operation spec section 12 is about, where losers
   * blocking briefly is preferable to losers racing and needing to be
   * detected after the fact.
   */
  async acceptRideIfSearching(
    rideId: string,
    driverId: string,
    vehicleId: string
  ): Promise<{ ride: RideRecord | null; conflict: boolean }> {
    return withTransaction(async (client) => {
      const { rows } = await client.query(`SELECT status FROM rides WHERE id = $1 FOR UPDATE`, [rideId]);
      if (rows.length === 0) return { ride: null, conflict: false };

      if (rows[0].status !== "SEARCHING_DRIVER") {
        return { ride: null, conflict: true };
      }

      await client.query(
        `UPDATE rides SET driver_id = $2, vehicle_id = $3, status = 'DRIVER_ASSIGNED', accepted_at = now(), updated_at = now()
         WHERE id = $1`,
        [rideId, driverId, vehicleId]
      );

      const ride = await this.findById(rideId, client);
      return { ride, conflict: false };
    });
  },

  async updateStatus(
    rideId: string,
    status: RideStatus,
    timestampColumn?: "arrived_at" | "started_at" | "completed_at" | "cancelled_at",
    extra?: { cancellationReason?: string }
  ): Promise<RideRecord | null> {
    const sets = [`status = $2::ride_status`, `updated_at = now()`];
    const values: unknown[] = [rideId, status];
    let i = 3;

    if (timestampColumn) {
      sets.push(`${timestampColumn} = now()`);
    }
    if (extra?.cancellationReason !== undefined) {
      sets.push(`cancellation_reason = $${i++}`);
      values.push(extra.cancellationReason);
    }

    await pool.query(`UPDATE rides SET ${sets.join(", ")} WHERE id = $1`, values);
    return this.findById(rideId);
  },

  /** Final fare saved at trip completion (Phase 6). The authoritative amount a rider is charged. */
  async findFareByRideId(rideId: string): Promise<{ total_fare: string; currency: string } | null> {
    const { rows } = await pool.query<{ total_fare: string; currency: string }>(
      `SELECT total_fare, currency FROM ride_fares WHERE ride_id = $1`,
      [rideId]
    );
    return rows[0] ?? null;
  },

  /**
   * Guarded transition: only applies if the ride is still in `from`.
   * Returns null if another writer got there first (Phase 12 uses this so
   * TRIP_COMPLETED -> PAYMENT_COMPLETED can never be applied twice).
   */
  async updateStatusIfCurrently(rideId: string, from: RideStatus, to: RideStatus): Promise<RideRecord | null> {
    const { rowCount } = await pool.query(
      `UPDATE rides SET status = $3::ride_status, updated_at = now() WHERE id = $1 AND status = $2::ride_status`,
      [rideId, from, to]
    );
    if (!rowCount) return null;
    return this.findById(rideId);
  },

  async saveFare(rideId: string, fare: FareBreakdown): Promise<void> {
    await pool.query(
      `INSERT INTO ride_fares (ride_id, base_fare, distance_charge, time_charge, booking_fee, surge_multiplier, discount, tax, total_fare, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        rideId,
        fare.baseFare,
        fare.distanceCharge,
        fare.timeCharge,
        fare.bookingFee,
        fare.surgeMultiplier,
        fare.discount,
        fare.tax,
        fare.totalFare,
        fare.currency,
      ]
    );
  },
};

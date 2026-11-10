import { pool, withTransaction } from "../../../db/pool";
import { CancelledBy, RentalBookingRecord, RentalBookingStatus } from "../types/rentals.types";

const BOOKING_SELECT = `
  SELECT b.*, l.owner_id, l.vehicle_id, (v.year || ' ' || v.brand || ' ' || v.model) AS vehicle_title
  FROM rental_bookings b
  JOIN rental_listings l ON l.id = b.rental_listing_id
  JOIN vehicles v ON v.id = l.vehicle_id`;

/** Thrown inside a transaction to roll it back when a guarded step loses its race. */
class Rollback extends Error {
  constructor(public readonly reason: string) { super(reason); }
}

export type StartOutcome =
  | { outcome: "started"; booking: RentalBookingRecord }
  | { outcome: "not_confirmed" | "vehicle_unavailable" };

export const rentalBookingsRepository = {
  async findById(id: string): Promise<RentalBookingRecord | null> {
    const { rows } = await pool.query<RentalBookingRecord>(`${BOOKING_SELECT} WHERE b.id = $1`, [id]);
    return rows[0] ?? null;
  },

  async findByIdempotencyKey(key: string): Promise<RentalBookingRecord | null> {
    const { rows } = await pool.query<RentalBookingRecord>(`${BOOKING_SELECT} WHERE b.idempotency_key = $1`, [key]);
    return rows[0] ?? null;
  },

  /**
   * The INSERT is what takes the vehicle. The exclusion constraint rejects it with 23P01 if any holding booking
   * overlaps, and the idempotency_key UNIQUE rejects a duplicate request with 23505.
   */
  async create(input: {
    listingId: string; renterId: string; startAt: Date; endAt: Date; rentAmount: number; depositAmount: number;
    hourlyRate: number; idempotencyKey: string; holdMs: number;
  }): Promise<RentalBookingRecord> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO rental_bookings
         (rental_listing_id, renter_id, start_at, end_at, total_amount, deposit_amount, hourly_rate_at_booking, idempotency_key, payment_due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9::float8))
       RETURNING id`,
      [input.listingId, input.renterId, input.startAt, input.endAt, input.rentAmount, input.depositAmount, input.hourlyRate, input.idempotencyKey, input.holdMs / 1000]
    );
    return (await this.findById(rows[0].id))!;
  },

  async listForRenter(renterId: string): Promise<RentalBookingRecord[]> {
    const { rows } = await pool.query<RentalBookingRecord>(`${BOOKING_SELECT} WHERE b.renter_id = $1 ORDER BY b.start_at DESC, b.id DESC`, [renterId]);
    return rows;
  },

  async listForOwner(ownerId: string, listingId?: string): Promise<RentalBookingRecord[]> {
    const { rows } = await pool.query<RentalBookingRecord>(
      `${BOOKING_SELECT} WHERE l.owner_id = $1 AND ($2::uuid IS NULL OR b.rental_listing_id = $2) ORDER BY b.start_at DESC, b.id DESC`,
      [ownerId, listingId ?? null]
    );
    return rows;
  },

  /** Time ranges that are NOT bookable, for the availability calendar. No renter details are exposed. */
  async blockedRanges(listingId: string, from: Date, to: Date): Promise<{ start_at: Date; end_at: Date; status: RentalBookingStatus }[]> {
    const { rows } = await pool.query(
      `SELECT start_at, end_at, status FROM rental_bookings
       WHERE rental_listing_id = $1
         AND (status IN ('CONFIRMED', 'ACTIVE') OR (status = 'PENDING_PAYMENT' AND payment_due_at > now()))
         AND tstzrange(start_at, end_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
       ORDER BY start_at`,
      [listingId, from, to]
    );
    return rows;
  },

  /** PENDING_PAYMENT holds on this listing whose deadline has passed (the delayed job may not have run yet). */
  async findStaleHoldIds(listingId: string): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM rental_bookings WHERE rental_listing_id = $1 AND status = 'PENDING_PAYMENT' AND payment_due_at <= now()`,
      [listingId]
    );
    return rows.map((r) => r.id);
  },

  /** PENDING_PAYMENT -> CONFIRMED. Null if the booking is no longer waiting for payment. */
  async confirm(id: string): Promise<RentalBookingRecord | null> {
    const { rowCount } = await pool.query(
      `UPDATE rental_bookings SET status = 'CONFIRMED', confirmed_at = now(), updated_at = now() WHERE id = $1 AND status = 'PENDING_PAYMENT'`,
      [id]
    );
    return rowCount ? this.findById(id) : null;
  },

  /** PENDING_PAYMENT -> EXPIRED once payment_due_at (minus grace) has passed. Null if not due / not pending. */
  async expireIfDue(id: string, graceMs: number): Promise<RentalBookingRecord | null> {
    const { rowCount } = await pool.query(
      `UPDATE rental_bookings SET status = 'EXPIRED', cancelled_at = now(), cancelled_by = 'SYSTEM', updated_at = now()
       WHERE id = $1 AND status = 'PENDING_PAYMENT' AND payment_due_at <= now() + make_interval(secs => $2::float8)`,
      [id, graceMs / 1000]
    );
    return rowCount ? this.findById(id) : null;
  },

  /** Guarded cancel from a given status. Null if the booking is no longer in `from`. */
  async cancel(id: string, from: "PENDING_PAYMENT" | "CONFIRMED", by: CancelledBy, refundAmount: number): Promise<RentalBookingRecord | null> {
    const { rowCount } = await pool.query(
      `UPDATE rental_bookings SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $3, refund_amount = $4, updated_at = now()
       WHERE id = $1 AND status = $2::rental_booking_status`,
      [id, from, by, refundAmount]
    );
    return rowCount ? this.findById(id) : null;
  },

  /**
   * Handover: CONFIRMED -> ACTIVE and the VEHICLE moves AVAILABLE -> RENTED in ONE transaction. That ties the rental to
   * the vehicle state machine: a vehicle that is out on a ride (IN_RIDE_SERVICE), in the garage or unavailable cannot be
   * handed over, and while it is RENTED no driver can put it into ride service (RENTED may only go back to AVAILABLE).
   */
  async start(id: string, vehicleId: string): Promise<StartOutcome> {
    try {
      await withTransaction(async (client) => {
        const v = await client.query(`UPDATE vehicles SET status = 'RENTED', updated_at = now() WHERE id = $1 AND status = 'AVAILABLE'`, [vehicleId]);
        if (!v.rowCount) throw new Rollback("vehicle_unavailable");
        const b = await client.query(
          `UPDATE rental_bookings SET status = 'ACTIVE', started_at = now(), updated_at = now() WHERE id = $1 AND status = 'CONFIRMED'`,
          [id]
        );
        if (!b.rowCount) throw new Rollback("not_confirmed");
      });
      return { outcome: "started", booking: (await this.findById(id))! };
    } catch (err) {
      if (err instanceof Rollback) return { outcome: err.reason as "not_confirmed" | "vehicle_unavailable" };
      throw err;
    }
  },

  /** Return: ACTIVE -> COMPLETED with the settlement, and the vehicle RENTED -> AVAILABLE, in one transaction. */
  async complete(id: string, vehicleId: string, s: {
    returnedAt: Date; lateFee: number; damageDeduction: number; depositRefundDue: number; notes?: string;
  }): Promise<RentalBookingRecord | null> {
    try {
      await withTransaction(async (client) => {
        const b = await client.query(
          `UPDATE rental_bookings
           SET status = 'COMPLETED', actual_return_at = $2, late_fee = $3, damage_deduction = $4, deposit_refund_due = $5,
               return_notes = $6, updated_at = now()
           WHERE id = $1 AND status = 'ACTIVE'`,
          [id, s.returnedAt, s.lateFee, s.damageDeduction, s.depositRefundDue, s.notes ?? null]
        );
        if (!b.rowCount) throw new Rollback("not_active");
        await client.query(`UPDATE vehicles SET status = 'AVAILABLE', updated_at = now() WHERE id = $1 AND status = 'RENTED'`, [vehicleId]);
      });
    } catch (err) {
      if (err instanceof Rollback) return null;
      throw err;
    }
    return this.findById(id);
  },
};

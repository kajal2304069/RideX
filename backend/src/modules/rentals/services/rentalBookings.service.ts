import { ApiError } from "../../../common/ApiError";
import { withLock } from "../../../common/redisLock";
import { env } from "../../../config/env";
import { logger } from "../../../config/logger";
import { scheduleBookingExpiry } from "../../../queues/rentalQueue";
import { earningsService } from "../../earnings/services/earnings.service";
import { payoutsService } from "../../earnings/services/payouts.service";
import { notificationsService } from "../../notifications/services/notifications.service";
import { paymentsRepository } from "../../payments/repositories/payments.repository";
import { rentalBookingsRepository } from "../repositories/rentalBookings.repository";
import { rentalListingsRepository } from "../repositories/rentalListings.repository";
import { CancelledBy, RentalBookingRecord, toPublicBooking } from "../types/rentals.types";
import { listingRates } from "./rentalListings.service";
import { calculateLateFee, calculateRentalPrice, settleDeposit, toPaise } from "./rentalPricing";
import { EARLY_HANDOVER_MS, assertValidWindow, refundForCancellation } from "./rentalRules";

const CURRENCY = "INR";
/** A delayed job may fire a hair before PostgreSQL's idea of the deadline. */
const EXPIRY_JOB_GRACE_MS = 5000;

const isPgCode = (err: unknown, code: string) => typeof err === "object" && err !== null && (err as { code?: string }).code === code;

/** The SAME key PaymentService locks for this payable, so expiry / cancel / payment can never interleave. */
export const rentalPaymentLockKey = (bookingId: string) => `lock:payment:RENTAL:${bookingId}`;
const LOCK_OPTS = { ttlMs: 15000, maxWaitMs: 10000 };

const totalDue = (b: RentalBookingRecord) => (toPaise(b.total_amount) + toPaise(b.deposit_amount)) / 100;

/** Renter or owner of the booking (or an admin) may see it; everyone else gets a 404. */
async function loadForParty(bookingId: string, userId: string, isAdmin = false): Promise<RentalBookingRecord> {
  const b = await rentalBookingsRepository.findById(bookingId);
  if (!b || (b.renter_id !== userId && b.owner_id !== userId && !isAdmin)) throw ApiError.notFound("Booking not found");
  return b;
}

/**
 * Refunds the (SUCCESS) payment for a booking. Imported lazily because payments -> rental resolver -> this service
 * would otherwise be an import cycle. Idempotent: no live SUCCESS payment means nothing to do.
 */
async function refundPaymentFor(bookingId: string): Promise<boolean> {
  const payment = await paymentsRepository.findLiveByPayable("RENTAL", bookingId);
  if (!payment || payment.status !== "SUCCESS") return false;
  const { paymentsService } = await import("../../payments/services/payments.service");
  await paymentsService.refund(payment.id);
  return true;
}

export const rentalBookingsService = {
  /**
   * Creates a booking that HOLDS the vehicle for RENTAL_PAYMENT_HOLD_MS. The INSERT is the atomic step: the exclusion
   * constraint rejects any overlap (23P01), so there is no check-then-insert race. Everything before it is a fast path
   * for friendly errors.
   */
  async book(renterId: string, listingId: string, input: { startAt: Date; endAt: Date; idempotencyKey: string }) {
    const storedKey = `${renterId}:${input.idempotencyKey}`;

    const replay = async (): Promise<{ booking: ReturnType<typeof toPublicBooking>; created: boolean } | null> => {
      const existing = await rentalBookingsRepository.findByIdempotencyKey(storedKey);
      if (!existing) return null;
      const same = existing.rental_listing_id === listingId
        && existing.start_at.getTime() === input.startAt.getTime() && existing.end_at.getTime() === input.endAt.getTime();
      if (!same) throw ApiError.conflict("Idempotency key was already used for a different booking");
      return { booking: toPublicBooking(existing), created: false };
    };
    const replayed = await replay();
    if (replayed) return replayed;

    const listing = await rentalListingsRepository.findById(listingId);
    if (!listing || !listing.is_active) throw ApiError.notFound("Rental listing not found");
    if (listing.owner_id === renterId) throw ApiError.badRequest("You cannot rent your own vehicle");
    assertValidWindow(input.startAt, input.endAt);

    // A hold whose deadline passed (job not run yet) must not block this renter.
    await this.expireStaleHolds(listingId);

    const quote = calculateRentalPrice(input.startAt, input.endAt, listingRates(listing));
    let booking: RentalBookingRecord;
    try {
      booking = await rentalBookingsRepository.create({
        listingId, renterId, startAt: input.startAt, endAt: input.endAt, rentAmount: quote.rent,
        depositAmount: Number(listing.security_deposit), hourlyRate: quote.effectiveHourlyRate,
        idempotencyKey: storedKey, holdMs: env.RENTAL_PAYMENT_HOLD_MS,
      });
    } catch (err) {
      if (isPgCode(err, "23P01") || isPgCode(err, "23505")) {
        // Either the dates are taken, or an identical request from this renter won the race and holds them: look.
        const again = await replay();
        if (again) return again;
        throw ApiError.conflict("This vehicle is not available for those dates");
      }
      throw err;
    }

    await scheduleBookingExpiry(booking.id, env.RENTAL_PAYMENT_HOLD_MS).catch((err) =>
      logger.error({ err, bookingId: booking.id }, "Could not schedule booking expiry job") // not fatal: see scheduleBookingExpiry
    );
    return { booking: toPublicBooking(booking), created: true };
  },

  async getOne(bookingId: string, userId: string, isAdmin: boolean) {
    return toPublicBooking(await loadForParty(bookingId, userId, isAdmin));
  },
  async listMine(renterId: string) {
    return (await rentalBookingsRepository.listForRenter(renterId)).map(toPublicBooking);
  },
  async listForOwner(ownerId: string, listingId?: string) {
    if (listingId) {
      const l = await rentalListingsRepository.findById(listingId);
      if (!l || l.owner_id !== ownerId) throw ApiError.notFound("Rental listing not found");
    }
    return (await rentalBookingsRepository.listForOwner(ownerId, listingId)).map(toPublicBooking);
  },

  // ---------- hold expiry ----------

  /**
   * Expires an unpaid hold. Under the SAME lock as the payment, and refuses while a live payment exists, so a renter who
   * is mid-payment can never lose the vehicle to the timer. Idempotent.
   */
  async expireGuarded(bookingId: string, graceMs: number): Promise<RentalBookingRecord | null> {
    return withLock(rentalPaymentLockKey(bookingId), async () => {
      if (await paymentsRepository.findLiveByPayable("RENTAL", bookingId)) return null;
      return rentalBookingsRepository.expireIfDue(bookingId, graceMs);
    }, LOCK_OPTS);
  },

  /** BullMQ job handler. */
  async expireIfDue(bookingId: string): Promise<void> {
    const expired = await this.expireGuarded(bookingId, EXPIRY_JOB_GRACE_MS);
    if (!expired) return;
    logger.info({ bookingId }, "Rental hold expired unpaid");
    void notificationsService.notify(expired.renter_id, "RENTAL_EXPIRED", expired.id);
  },

  async expireStaleHolds(listingId: string): Promise<void> {
    for (const id of await rentalBookingsRepository.findStaleHoldIds(listingId)) await this.expireIfDue(id);
  },

  // ---------- payment hook ----------

  /**
   * Called by the RENTAL payment resolver after money moved. PENDING_PAYMENT -> CONFIRMED. Idempotent: replaying a
   * paid request after the booking moved on does nothing.
   */
  async confirmAfterPayment(bookingId: string): Promise<void> {
    const b = await rentalBookingsRepository.findById(bookingId);
    if (!b) throw ApiError.notFound("Booking not found");
    if (b.status === "CONFIRMED" || b.status === "ACTIVE" || b.status === "COMPLETED") return;

    if (b.status === "CANCELLED" || b.status === "EXPIRED") {
      // Money moved for a booking that is dead. The shared lock should make this unreachable (it can only happen if the
      // lock expired mid-flight), so do not leave the renter out of pocket: give it back.
      logger.error({ bookingId, status: b.status }, "RENTAL payment succeeded for a dead booking - refunding");
      await refundPaymentFor(bookingId);
      return;
    }

    const confirmed = await rentalBookingsRepository.confirm(bookingId);
    if (!confirmed) return; // someone else confirmed it first: fine
    void notificationsService.notify(confirmed.renter_id, "RENTAL_CONFIRMED", confirmed.id);
    void notificationsService.notify(confirmed.owner_id, "RENTAL_BOOKED", confirmed.id, { vehicle: confirmed.vehicle_title });
  },

  // ---------- cancel ----------

  /**
   * Either party cancels. What happens depends on the state:
   *   PENDING_PAYMENT  -> CANCELLED, nothing to refund (refused while a payment is in flight)
   *   CONFIRMED        -> CANCELLED, refund per policy (owner: full; renter: full if >= 24h before start, else none)
   *   CANCELLED        -> re-attempts a refund that failed earlier (idempotent), otherwise 409
   *   ACTIVE/terminal  -> 409 (an ACTIVE rental ends with the return)
   */
  async cancel(bookingId: string, userId: string) {
    const first = await loadForParty(bookingId, userId);
    const by: CancelledBy = first.owner_id === userId ? "OWNER" : "RENTER";

    return withLock(rentalPaymentLockKey(bookingId), async () => {
      const b = (await rentalBookingsRepository.findById(bookingId))!;

      if (b.status === "CANCELLED" && Number(b.refund_amount) > 0) {
        await refundPaymentFor(bookingId); // finish a refund that failed the first time
        return toPublicBooking((await rentalBookingsRepository.findById(bookingId))!);
      }
      if (b.status !== "PENDING_PAYMENT" && b.status !== "CONFIRMED") {
        throw ApiError.conflict(
          b.status === "ACTIVE" ? "An active rental cannot be cancelled; the owner completes it on return" : `A ${b.status} booking cannot be cancelled`
        );
      }

      let refund = 0;
      if (b.status === "PENDING_PAYMENT") {
        if (await paymentsRepository.findLiveByPayable("RENTAL", bookingId)) throw ApiError.conflict("A payment for this booking is in progress");
      } else {
        refund = refundForCancellation(by, b.start_at, totalDue(b));
      }

      const cancelled = await rentalBookingsRepository.cancel(bookingId, b.status, by, refund);
      if (!cancelled) throw ApiError.conflict("Booking was changed by someone else; reload and retry");

      if (refund > 0) await refundPaymentFor(bookingId); // if this throws, the booking stays CANCELLED with refund_amount set: retry the cancel call
      const other = by === "OWNER" ? cancelled.renter_id : cancelled.owner_id;
      void notificationsService.notify(other, "RENTAL_CANCELLED", cancelled.id, { cancelledBy: by });
      return toPublicBooking((await rentalBookingsRepository.findById(bookingId))!);
    }, LOCK_OPTS);
  },

  // ---------- handover and return (owner) ----------

  async start(bookingId: string, ownerId: string) {
    const b = await rentalBookingsRepository.findById(bookingId);
    if (!b || b.owner_id !== ownerId) throw ApiError.notFound("Booking not found");
    if (b.status !== "CONFIRMED") throw ApiError.conflict(`A ${b.status} booking cannot be started`);

    const now = Date.now();
    if (now < b.start_at.getTime() - EARLY_HANDOVER_MS) throw ApiError.badRequest("Too early to hand over: the rental has not begun");
    if (now >= b.end_at.getTime()) throw ApiError.conflict("The booked period has already ended");

    const r = await rentalBookingsRepository.start(bookingId, b.vehicle_id);
    if (r.outcome !== "started") {
      throw ApiError.conflict(
        r.outcome === "vehicle_unavailable"
          ? "The vehicle is not available right now (in ride service, maintenance or already rented)"
          : "Booking was changed by someone else; reload and retry"
      );
    }
    void notificationsService.notify(r.booking.renter_id, "RENTAL_STARTED", r.booking.id);
    return toPublicBooking(r.booking);
  },

  /**
   * Return. Server computes the late fee from the real return time; the owner may add a damage deduction. Together they
   * come out of the deposit and can never exceed it. The deposit refund is recorded (deposit_refund_due) and then paid back to the renter
   * (Phase 17 payouts); the owner's share is written to the earnings ledger.
   */
  async complete(bookingId: string, ownerId: string, input: { damageDeduction?: number; notes?: string }) {
    const b = await rentalBookingsRepository.findById(bookingId);
    if (!b || b.owner_id !== ownerId) throw ApiError.notFound("Booking not found");
    if (b.status !== "ACTIVE") throw ApiError.conflict(`A ${b.status} booking cannot be completed`);

    const deposit = Number(b.deposit_amount);
    const damage = input.damageDeduction ?? 0;
    if (toPaise(damage) > toPaise(deposit)) throw ApiError.badRequest("The damage deduction cannot exceed the security deposit");

    const returnedAt = new Date();
    const lateFee = calculateLateFee(b.end_at, returnedAt, Number(b.hourly_rate_at_booking));
    const { refundDue } = settleDeposit(deposit, lateFee, damage);

    const done = await rentalBookingsRepository.complete(bookingId, b.vehicle_id, {
      returnedAt, lateFee, damageDeduction: damage, depositRefundDue: refundDue, notes: input.notes,
    });
    if (!done) throw ApiError.conflict("Booking was changed by someone else; reload and retry");
    // Money bookkeeping after the return. Neither may fail the return (the vehicle is already back); reconcile repairs them.
    await earningsService.settleRentalSafely(bookingId);
    try { await payoutsService.refundDeposit(bookingId); } catch (err) { logger.error({ err, bookingId }, "Deposit refund failed; reconcile will retry"); }
    void notificationsService.notify(done.renter_id, "RENTAL_COMPLETED", done.id, { depositRefundDue: refundDue, currency: CURRENCY });
    return toPublicBooking(done);
  },
};

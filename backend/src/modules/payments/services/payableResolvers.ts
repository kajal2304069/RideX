import { ApiError } from "../../../common/ApiError";
import { ridesRepository } from "../../rides/repositories/rides.repository";
import { ridesService } from "../../rides/services/rides.service";
import { repairsRepository } from "../../repairs/repositories/repairs.repository";
import { repairsService } from "../../repairs/services/repairs.service";
import { env } from "../../../config/env";
import { offersRepository } from "../../marketplace/repositories/offers.repository";
import { offersService } from "../../marketplace/services/offers.service";
import { rentalBookingsRepository } from "../../rentals/repositories/rentalBookings.repository";
import { rentalBookingsService } from "../../rentals/services/rentalBookings.service";
import { PayableType, ResolvedPayable } from "../types/payments.types";

/**
 * Each payable type plugs in two things:
 *   resolve():   is this thing payable right now, who owes, and how much?
 *                (the amount is ALWAYS computed server-side)
 *   onSuccess(): what changes in the owning module once money has moved
 *
 * This is what makes the `payments` table polymorphic without PaymentService
 * knowing anything about rides, rentals or marketplace orders. RENTAL,
 * MARKETPLACE and GARAGE_SERVICE register here in Phases 14-16.
 */
export interface PayableResolver {
  resolve(payableId: string): Promise<ResolvedPayable>;
  onSuccess(payableId: string): Promise<void>;
}

const rideResolver: PayableResolver = {
  async resolve(rideId) {
    const ride = await ridesRepository.findById(rideId);
    if (!ride) throw ApiError.notFound("Ride not found");

    if (ride.status === "PAYMENT_COMPLETED") throw ApiError.conflict("Ride is already paid");
    if (ride.status !== "TRIP_COMPLETED") {
      throw ApiError.badRequest(`Ride cannot be paid while in status ${ride.status}`);
    }

    const fare = await ridesRepository.findFareByRideId(rideId);
    if (!fare) throw ApiError.internal("Completed ride has no saved fare");

    return { payerId: ride.rider_id, amount: Number(fare.total_fare), currency: fare.currency };
  },

  async onSuccess(rideId) {
    await ridesService.markPaymentCompleted(rideId);
  },
};

const garageServiceResolver: PayableResolver = {
  async resolve(bookingId) {
    const booking = await repairsRepository.findById(bookingId);
    if (!booking) throw ApiError.notFound("Booking not found");

    if (booking.status === "COMPLETED") throw ApiError.conflict("Booking is already paid");
    // Only READY bookings are payable: by then the repair order is frozen, so the amount cannot move.
    if (booking.status !== "READY") throw ApiError.badRequest(`Booking cannot be paid while in status ${booking.status}`);

    const order = await repairsRepository.findRepairOrder(bookingId);
    if (!order || Number(order.total_cost) <= 0) throw ApiError.internal("Ready booking has no repair cost");

    return { payerId: booking.customer_id, amount: Number(order.total_cost), currency: "INR" };
  },

  async onSuccess(bookingId) {
    await repairsService.completeAfterPayment(bookingId);
  },
};

/**
 * MARKETPLACE payables are ACCEPTED OFFERS. Accepting reserves the listing; paying completes the sale. This resolver
 * already runs inside PaymentService's per-payable lock, which is the same lock the expiry job takes, so it must NOT
 * call offersService.expireGuarded (that would wait on a lock this very request holds). It expires inline instead.
 */
const marketplaceResolver: PayableResolver = {
  async resolve(offerId) {
    const offer = await offersRepository.findById(offerId);
    if (!offer) throw ApiError.notFound("Offer not found");

    if (offer.listing_status === "SOLD") throw ApiError.conflict("This vehicle has already been sold");
    if (offer.status === "EXPIRED") throw ApiError.conflict("This offer has expired");
    if (offer.status !== "ACCEPTED") throw ApiError.badRequest(`Offer cannot be paid while ${offer.status}`);

    // The deadline is enforced here even if the delayed expiry job was lost or has not fired yet.
    if (offer.accepted_at && Date.now() - offer.accepted_at.getTime() > env.OFFER_ACCEPTANCE_TTL_MS) {
      await offersRepository.expireAcceptedIfDue(offerId, env.OFFER_ACCEPTANCE_TTL_MS, 0);
      throw ApiError.conflict("This offer has expired");
    }
    return { payerId: offer.buyer_id, amount: Number(offer.offer_amount), currency: "INR" };
  },

  async onSuccess(offerId) {
    await offersService.completeSale(offerId);
  },
};

/**
 * RENTAL payables are BOOKINGS in PENDING_PAYMENT. The charge is rent + security deposit, both read from the booking
 * (priced when it was created), never from the client. As with MARKETPLACE this runs inside PaymentService's per-payable
 * lock, which the expiry job and cancel share, so it expires a lapsed hold inline instead of calling the locking path.
 */
const rentalResolver: PayableResolver = {
  async resolve(bookingId) {
    const b = await rentalBookingsRepository.findById(bookingId);
    if (!b) throw ApiError.notFound("Booking not found");

    if (b.status === "CONFIRMED" || b.status === "ACTIVE" || b.status === "COMPLETED") throw ApiError.conflict("This booking is already paid");
    if (b.status === "CANCELLED" || b.status === "EXPIRED") throw ApiError.conflict(`This booking is ${b.status.toLowerCase()} and can no longer be paid`);

    // The hold deadline is enforced here even if the delayed expiry job was lost or has not fired yet.
    if (!b.payment_due_at || b.payment_due_at.getTime() <= Date.now()) {
      await rentalBookingsRepository.expireIfDue(bookingId, 0);
      throw ApiError.conflict("This booking hold has expired; please book again");
    }
    const cents = Math.round(Number(b.total_amount) * 100) + Math.round(Number(b.deposit_amount) * 100);
    return { payerId: b.renter_id, amount: cents / 100, currency: "INR" };
  },

  async onSuccess(bookingId) {
    await rentalBookingsService.confirmAfterPayment(bookingId);
  },
};

const resolvers: Partial<Record<PayableType, PayableResolver>> = {
  RIDE: rideResolver,
  GARAGE_SERVICE: garageServiceResolver,
  MARKETPLACE: marketplaceResolver,
  RENTAL: rentalResolver,
};

export function getPayableResolver(type: PayableType): PayableResolver {
  const resolver = resolvers[type];
  if (!resolver) {
    throw new ApiError(501, "NOT_IMPLEMENTED", `Payments for ${type} are not available yet`);
  }
  return resolver;
}

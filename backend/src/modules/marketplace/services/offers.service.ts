import { ApiError } from "../../../common/ApiError";
import { withLock } from "../../../common/redisLock";
import { env } from "../../../config/env";
import { logger } from "../../../config/logger";
import { notificationsService } from "../../notifications/services/notifications.service";
import { paymentsRepository } from "../../payments/repositories/payments.repository";
import { scheduleOfferExpiry } from "../../../queues/marketplaceQueue";
import { listingsRepository } from "../repositories/listings.repository";
import { offersRepository } from "../repositories/offers.repository";
import { OfferRecord, OfferStatus, toPublicOffer } from "../types/marketplace.types";

const CURRENCY = "INR";
/** Business rule: an offer below half the asking price is rejected outright (stops joke/lowball spam). */
export const MIN_OFFER_RATIO = 0.5;
/** The delayed job may fire a hair before PostgreSQL's idea of the deadline; the payment path uses no grace. */
const EXPIRY_JOB_GRACE_MS = 5000;

const isPgCode = (err: unknown, code: string) => typeof err === "object" && err !== null && (err as { code?: string }).code === code;

/** Same lock key PaymentService uses for this payable, so expiry and payment can never interleave. */
export const paymentLockKey = (offerId: string) => `lock:payment:MARKETPLACE:${offerId}`;

async function loadOfferForSeller(offerId: string, sellerId: string): Promise<OfferRecord> {
  const offer = await offersRepository.findById(offerId);
  if (!offer || offer.seller_id !== sellerId) throw ApiError.notFound("Offer not found");
  return offer;
}

export const offersService = {
  async create(buyerId: string, listingId: string, amount: number) {
    const listing = await listingsRepository.findById(listingId);
    if (!listing || listing.status === "DELISTED") throw ApiError.notFound("Listing not found");
    if (listing.status === "SOLD") throw ApiError.conflict("This vehicle has been sold");
    if (listing.seller_id === buyerId) throw ApiError.badRequest("You cannot make an offer on your own listing");

    const price = Number(listing.price);
    if (amount > price) throw ApiError.badRequest("An offer cannot exceed the asking price");
    if (amount < price * MIN_OFFER_RATIO) throw ApiError.badRequest(`An offer must be at least ${MIN_OFFER_RATIO * 100}% of the asking price`);

    // A stale reservation (buyer never paid) should not block new offers just because the delayed job has not run yet.
    await this.expireStaleReservation(listingId);
    const fresh = await listingsRepository.findById(listingId);
    if (fresh?.is_reserved) throw ApiError.conflict("This vehicle is reserved for another buyer");

    try {
      const offer = await offersRepository.create(listingId, buyerId, amount);
      void notificationsService.notify(listing.seller_id, "OFFER_RECEIVED", offer.id, { amount, currency: CURRENCY });
      return toPublicOffer(offer);
    } catch (err) {
      if (isPgCode(err, "23505")) throw ApiError.conflict("You already have a pending offer on this listing; withdraw it first");
      throw err;
    }
  },

  async listForListing(listingId: string, sellerId: string, status?: OfferStatus) {
    const listing = await listingsRepository.findById(listingId);
    if (!listing || listing.seller_id !== sellerId) throw ApiError.notFound("Listing not found");
    return (await offersRepository.listForListing(listingId, status)).map(toPublicOffer);
  },

  async listMine(buyerId: string) {
    return (await offersRepository.listForBuyer(buyerId)).map(toPublicOffer);
  },

  /** Buyer retracts a PENDING offer. (An ACCEPTED offer cannot be withdrawn: it is a commitment that lapses on its own.) */
  async withdraw(offerId: string, buyerId: string) {
    const offer = await offersRepository.findById(offerId);
    if (!offer || offer.buyer_id !== buyerId) throw ApiError.notFound("Offer not found");
    if (offer.status !== "PENDING") throw ApiError.conflict(`A ${offer.status} offer cannot be withdrawn`);
    if (!(await offersRepository.transition(offerId, "PENDING", "WITHDRAWN"))) throw ApiError.conflict("Offer was changed by someone else; reload and retry");
    return toPublicOffer((await offersRepository.findById(offerId))!);
  },

  async reject(offerId: string, sellerId: string) {
    const offer = await loadOfferForSeller(offerId, sellerId);
    if (offer.status !== "PENDING") throw ApiError.conflict(`A ${offer.status} offer cannot be rejected`);
    if (!(await offersRepository.transition(offerId, "PENDING", "REJECTED"))) throw ApiError.conflict("Offer was changed by someone else; reload and retry");
    void notificationsService.notify(offer.buyer_id, "OFFER_REJECTED", offer.id);
    return toPublicOffer((await offersRepository.findById(offerId))!);
  },

  /** Seller accepts: reserves the listing for this buyer, rejects the rest, and starts the payment clock. */
  async accept(offerId: string, sellerId: string) {
    const offer = await loadOfferForSeller(offerId, sellerId);
    await this.expireStaleReservation(offer.listing_id);

    let result;
    try {
      result = await offersRepository.acceptOffer(offerId);
    } catch (err) {
      // The partial unique index (one ACCEPTED per listing) caught a race the row lock somehow missed.
      if (isPgCode(err, "23505")) throw ApiError.conflict("Another offer was accepted first");
      throw err;
    }

    if (result.outcome !== "accepted") {
      const messages = {
        not_found: [404, "Offer not found"],
        listing_not_active: [409, "The listing is no longer active"],
        offer_not_pending: [409, "That offer is no longer pending"],
        already_reserved: [409, "Another offer has already been accepted for this listing"],
      } as const;
      const [status, message] = messages[result.outcome];
      throw status === 404 ? ApiError.notFound(message) : ApiError.conflict(message);
    }

    const { offer: accepted, rejectedBuyerIds } = result;
    await scheduleOfferExpiry(accepted.id, env.OFFER_ACCEPTANCE_TTL_MS).catch((err) =>
      // Not fatal: the payment path enforces the deadline itself, and the next offer/accept lazily expires it.
      logger.error({ err, offerId }, "Could not schedule offer expiry job")
    );
    void notificationsService.notify(accepted.buyer_id, "OFFER_ACCEPTED", accepted.id, {
      amount: Number(accepted.offer_amount), currency: CURRENCY, payWithinHours: Math.round(env.OFFER_ACCEPTANCE_TTL_MS / 3_600_000),
    });
    for (const buyerId of rejectedBuyerIds) void notificationsService.notify(buyerId, "OFFER_REJECTED", `${accepted.listing_id}__${buyerId}`);
    return toPublicOffer(accepted);
  },

  /**
   * Expires an accepted-but-unpaid offer. Runs under the SAME lock the payment uses and refuses to expire while a live
   * payment exists, so a buyer who is mid-payment can never have the rug pulled out by the timer. Idempotent.
   */
  async expireGuarded(offerId: string, graceMs: number): Promise<OfferRecord | null> {
    return withLock(paymentLockKey(offerId), async () => {
      const live = await paymentsRepository.findLiveByPayable("MARKETPLACE", offerId);
      if (live) return null;
      return offersRepository.expireAcceptedIfDue(offerId, env.OFFER_ACCEPTANCE_TTL_MS, graceMs);
    }, { ttlMs: 15000, maxWaitMs: 10000 });
  },

  /** BullMQ job handler. */
  async expireIfDue(offerId: string): Promise<void> {
    const expired = await this.expireGuarded(offerId, EXPIRY_JOB_GRACE_MS);
    if (!expired) return;
    logger.info({ offerId }, "Accepted offer expired unpaid");
    void notificationsService.notify(expired.buyer_id, "OFFER_EXPIRED", expired.id);
    void notificationsService.notify(expired.seller_id, "OFFER_EXPIRED", expired.id);
  },

  async expireStaleReservation(listingId: string): Promise<void> {
    const accepted = await offersRepository.findAcceptedForListing(listingId);
    if (accepted) await this.expireIfDue(accepted.id);
  },

  /**
   * Called by the MARKETPLACE payment resolver after money has moved. The listing becomes SOLD and the seller is told.
   * Idempotent (guarded UPDATE), so a replayed payment event does nothing the second time.
   */
  async completeSale(offerId: string): Promise<void> {
    const offer = await offersRepository.findById(offerId);
    if (!offer) throw ApiError.notFound("Offer not found");
    if (offer.status !== "ACCEPTED") {
      // Payment succeeded for an offer that is not payable. The lock + live-payment check should make this unreachable.
      logger.error({ offerId, status: offer.status }, "MARKETPLACE payment succeeded for a non-ACCEPTED offer - needs manual refund");
      return;
    }
    const sold = await offersRepository.markListingSold(offer.listing_id);
    if (sold) {
      void notificationsService.notify(offer.seller_id, "LISTING_SOLD", offer.id, { amount: Number(offer.offer_amount), currency: CURRENCY });
      logger.info({ offerId, listingId: offer.listing_id }, "Listing sold");
    }
  },
};

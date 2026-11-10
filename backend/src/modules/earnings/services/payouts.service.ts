import { ApiError } from "../../../common/ApiError";
import { withLock } from "../../../common/redisLock";
import { env } from "../../../config/env";
import { logger } from "../../../config/logger";
import { notificationsService } from "../../notifications/services/notifications.service";
import { paymentsRepository } from "../../payments/repositories/payments.repository";
import { getPaymentProvider } from "../../payments/services/providers";
import { rentalBookingsRepository } from "../../rentals/repositories/rentalBookings.repository";
import { earningsRepository } from "../repositories/earnings.repository";
import { PayoutRecord, toPublicPayout } from "../types/earnings.types";
import { getPayoutProvider } from "./PayoutProvider";

const CURRENCY = "INR";
const LOCK_OPTS = { ttlMs: 15000, maxWaitMs: 10000 };
const payoutLock = (id: string) => `lock:payout:${id}`;

export const payoutsService = {
  /**
   * Withdraw earnings. Three layers, same shape as payments:
   *   1. the reservation runs under a row lock on the user, so concurrent withdrawals cannot overdraw the balance
   *   2. the idempotency key (namespaced by user) makes a retried request return the SAME payout, never a second one
   *   3. a provider error leaves the payout PENDING (outcome unknown), so the money stays reserved and a retry with the
   *      same key finishes it; only an explicit rejection (FAILED) releases the money back to the balance
   */
  async withdraw(userId: string, input: { amount?: number; idempotencyKey: string }) {
    const storedKey = `${userId}:${input.idempotencyKey}`;
    const r = await earningsRepository.reserveWithdrawal({
      userId, amount: input.amount ?? null, minAmount: env.MIN_PAYOUT_AMOUNT, idempotencyKey: storedKey, currency: CURRENCY,
    });

    if ("error" in r) {
      if (r.error === "NO_FUNDS") throw ApiError.conflict("You have no earnings available to withdraw");
      if (r.error === "BELOW_MINIMUM") throw ApiError.badRequest(`The minimum withdrawal is ${CURRENCY} ${env.MIN_PAYOUT_AMOUNT.toFixed(2)}`);
      throw ApiError.conflict(`Insufficient balance: ${CURRENCY} ${r.available.toFixed(2)} available`);
    }
    if (!r.created && input.amount !== undefined && Math.round(Number(r.payout.amount) * 100) !== Math.round(input.amount * 100)) {
      throw ApiError.conflict("Idempotency key was already used for a different withdrawal");
    }
    return toPublicPayout(await this.drive(r.payout));
  },

  /** Drives a PENDING withdrawal to PAID/FAILED. PAID and FAILED are returned as they are, so replays are harmless. */
  async drive(payout: PayoutRecord): Promise<PayoutRecord> {
    if (payout.status !== "PENDING") return payout;
    return withLock(payoutLock(payout.id), async () => {
      const fresh = (await earningsRepository.findPayout(payout.id))!;
      if (fresh.status !== "PENDING") return fresh;

      let result;
      try {
        result = await getPayoutProvider().payout({ userId: fresh.user_id, amount: Number(fresh.amount), currency: fresh.currency, idempotencyKey: fresh.idempotency_key });
      } catch (err) {
        logger.error({ err, payoutId: fresh.id }, "Payout provider errored; leaving payout PENDING");
        throw new ApiError(502, "PAYOUT_PROVIDER_ERROR", "Payout provider unavailable. Retry with the same Idempotency-Key.");
      }

      if (result.status === "FAILED") {
        return (await earningsRepository.transitionPayout(fresh.id, ["PENDING"], "FAILED", { reason: result.failureReason })) ?? (await earningsRepository.findPayout(fresh.id))!;
      }
      const paid = await earningsRepository.transitionPayout(fresh.id, ["PENDING"], "PAID", { reference: result.reference });
      const final = paid ?? (await earningsRepository.findPayout(fresh.id))!;
      if (paid) void notificationsService.notify(final.user_id, "PAYOUT_PAID", final.id, { amount: Number(final.amount), currency: final.currency });
      return final;
    }, LOCK_OPTS);
  },

  /**
   * Returns the refundable part of a rental deposit to the renter, as a PARTIAL refund of the original charge.
   * One payout row per booking (unique index) so it can only ever be created once; the provider call is guarded by a
   * lock and a status transition so it can only ever be PAID once. Returns true when money was moved by this call.
   */
  async refundDeposit(bookingId: string): Promise<boolean> {
    const b = await rentalBookingsRepository.findById(bookingId);
    if (!b || b.status !== "COMPLETED") return false;
    const due = Number(b.deposit_refund_due);
    if (!(due > 0)) return false;

    const payout = await earningsRepository.upsertDepositRefund({ renterId: b.renter_id, bookingId, amount: due, currency: CURRENCY });
    if (payout.status === "PAID") return false;

    return withLock(payoutLock(payout.id), async () => {
      const fresh = (await earningsRepository.findPayout(payout.id))!;
      if (fresh.status === "PAID") return false;

      const payment = await paymentsRepository.findLiveByPayable("RENTAL", bookingId);
      if (!payment || payment.status !== "SUCCESS" || !payment.provider_reference) {
        await earningsRepository.transitionPayout(fresh.id, ["PENDING", "FAILED"], "FAILED", { reason: "no successful payment to refund against" });
        logger.error({ bookingId }, "Deposit refund has no payment to refund against");
        return false;
      }

      let ref;
      try {
        ref = await getPaymentProvider().refund(payment.provider_reference, Number(fresh.amount));
      } catch (err) {
        logger.error({ err, bookingId }, "Deposit refund provider call errored; will be retried");
        throw new ApiError(502, "PAYOUT_PROVIDER_ERROR", "Refund provider unavailable; it will be retried");
      }
      const paid = await earningsRepository.transitionPayout(fresh.id, ["PENDING", "FAILED"], "PAID", { reference: ref.reference });
      if (!paid) return false;
      void notificationsService.notify(b.renter_id, "DEPOSIT_REFUNDED", b.id, { amount: Number(fresh.amount), currency: CURRENCY });
      return true;
    }, LOCK_OPTS);
  },

  async listMine(userId: string, limit: number) {
    return (await earningsRepository.listPayouts(userId, limit)).map(toPublicPayout);
  },
};

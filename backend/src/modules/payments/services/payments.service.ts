import { paymentsTotal } from "../../../observability/metrics";
import { ApiError } from "../../../common/ApiError";
import { withLock } from "../../../common/redisLock";
import { logger } from "../../../config/logger";
import { notificationsService } from "../../notifications/services/notifications.service";
import { paymentsRepository } from "../repositories/payments.repository";
import { PayableType, PaymentRecord, PublicPayment, toPublicPayment } from "../types/payments.types";
import { getPayableResolver } from "./payableResolvers";
import { getPaymentProvider } from "./providers";

/** Raised by `pg` for a Postgres unique_violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): err is { code: "23505" } {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export interface PayInput {
  payableType: PayableType;
  payableId: string;
  paymentMethodToken: string;
  idempotencyKey: string;
}

/**
 * Payment state machine:
 *
 *   PENDING --> PROCESSING --> SUCCESS --> REFUNDED
 *                         \--> FAILED
 *
 * Three layers keep a payable from being charged twice. Each one alone is
 * enough for the simple case; together they cover the hard ones:
 *
 *   1. Idempotency key (namespaced per payer): a retried request returns
 *      the original payment instead of charging again.
 *   2. Redis lock per payable: serializes concurrent attempts, including
 *      ones with DIFFERENT keys (two devices, double-tap with fresh keys).
 *   3. Partial unique index in Postgres: the actual guarantee. If the lock
 *      expires mid-flight or Redis is down, the second INSERT still fails
 *      with 23505 and we map it to a 409.
 *
 * The provider is also given the idempotency key, so a retry after a
 * timeout is deduplicated on the gateway's side as well.
 */
export const paymentsService = {
  async pay(payerId: string, input: PayInput): Promise<PublicPayment> {
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 100) {
      throw ApiError.badRequest("Idempotency-Key must be 8-100 characters");
    }
    // Namespace by payer so one user's key can never collide with, or reveal, another's.
    const storedKey = `${payerId}:${input.idempotencyKey}`;

    return withLock(
      `lock:payment:${input.payableType}:${input.payableId}`,
      async () => {
        // 1. Replay of an earlier request?
        const existing = await paymentsRepository.findByIdempotencyKey(storedKey);
        if (existing) {
          if (existing.payable_type !== input.payableType || existing.payable_id !== input.payableId) {
            throw ApiError.conflict("Idempotency-Key was already used for a different payment");
          }
          return toPublicPayment(await paymentsService.settle(existing, input.paymentMethodToken));
        }

        // 2. Is the thing payable, and does this user owe it?
        const resolver = getPayableResolver(input.payableType);
        const payable = await resolver.resolve(input.payableId);
        if (payable.payerId !== payerId) {
          // 404, not 403: don't confirm that someone else's payable exists.
          throw ApiError.notFound("Payable not found");
        }

        // 3. Fast-path duplicate check with a different key.
        const live = await paymentsRepository.findLiveByPayable(input.payableType, input.payableId);
        if (live) throw ApiError.conflict("This item already has a payment in progress or completed");

        // 4. Record intent BEFORE touching the provider, so a crash mid-charge leaves a trail.
        let payment: PaymentRecord;
        try {
          payment = await paymentsRepository.createPending({
            payableType: input.payableType,
            payableId: input.payableId,
            payerId,
            amount: payable.amount,
            currency: payable.currency,
            provider: getPaymentProvider().name,
            idempotencyKey: storedKey,
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            // Lock failed us (expired / Redis blip). The DB caught the duplicate.
            const winner = await paymentsRepository.findByIdempotencyKey(storedKey);
            if (winner) return toPublicPayment(winner);
            throw ApiError.conflict("This item already has a payment in progress or completed");
          }
          throw err;
        }

        return toPublicPayment(await paymentsService.settle(payment, input.paymentMethodToken));
      },
      // Provider calls are slow relative to DB calls; give the holder room.
      { ttlMs: 15000, maxWaitMs: 10000 }
    );
  },

  /**
   * Drives a payment to a terminal state. Safe to call on a payment in any
   * state: FAILED/REFUNDED are returned as-is, SUCCESS re-runs the idempotent follow-up, while PENDING and
   * PROCESSING are (re)driven. Re-driving a PROCESSING payment re-calls the
   * provider with the SAME idempotency key, which a real gateway dedupes, so
   * a client retry after a timeout completes the payment rather than
   * duplicating or abandoning it.
   */
  async settle(payment: PaymentRecord, paymentMethodToken: string): Promise<PaymentRecord> {
    if (payment.status === "SUCCESS") {
      // Replay of a paid request. Re-run the (idempotent) follow-up in case
      // it failed last time after the money had already moved.
      await getPayableResolver(payment.payable_type).onSuccess(payment.payable_id);
      return payment;
    }
    if (payment.status !== "PENDING" && payment.status !== "PROCESSING") return payment;

    const processing = (await paymentsRepository.transition(payment.id, ["PENDING", "PROCESSING"], "PROCESSING")) ?? payment;

    let result;
    try {
      result = await getPaymentProvider().charge({
        amount: Number(processing.amount),
        currency: processing.currency,
        paymentMethodToken,
        idempotencyKey: processing.idempotency_key,
        metadata: { paymentId: processing.id, payableType: processing.payable_type, payableId: processing.payable_id },
      });
    } catch (err) {
      // The outcome is UNKNOWN (the charge may have gone through). Marking
      // FAILED could let the user pay again and be charged twice, so stay
      // PROCESSING and let a retry with the same key resolve it.
      logger.error({ err, paymentId: processing.id }, "Payment provider call errored; leaving payment PROCESSING");
      throw new ApiError(502, "PAYMENT_PROVIDER_ERROR", "Payment provider unavailable. Retry with the same Idempotency-Key.");
    }

    if (result.status === "FAILED") {
      const failed = await paymentsRepository.transition(processing.id, ["PROCESSING"], "FAILED", {
        providerReference: result.reference,
        failureReason: result.failureReason,
      });
      paymentsTotal.inc({ status: "FAILED" });
      logger.info({ paymentId: processing.id, reason: result.failureReason }, "Payment failed");
      return failed ?? (await paymentsRepository.findById(processing.id))!;
    }

    const succeeded = await paymentsRepository.transition(processing.id, ["PROCESSING"], "SUCCESS", {
      providerReference: result.reference,
    });
    const final = succeeded ?? (await paymentsRepository.findById(processing.id))!;

    // Run the owning module's follow-up. It is idempotent, so if it throws
    // here (and the client retries), re-driving a SUCCESS payment below is safe.
    if (final.status === "SUCCESS") {
      if (succeeded) paymentsTotal.inc({ status: "SUCCESS" });
      await getPayableResolver(final.payable_type).onSuccess(final.payable_id);
      logger.info({ paymentId: final.id, payableType: final.payable_type }, "Payment succeeded");
      void notificationsService.notify(final.payer_id, "PAYMENT_SUCCESS", final.id, { amount: Number(final.amount), currency: final.currency });
    }
    return final;
  },

  async getOne(paymentId: string, requesterId: string, isAdmin: boolean): Promise<PublicPayment> {
    const payment = await paymentsRepository.findById(paymentId);
    if (!payment || (payment.payer_id !== requesterId && !isAdmin)) {
      throw ApiError.notFound("Payment not found");
    }
    return toPublicPayment(payment);
  },

  async listMine(payerId: string): Promise<PublicPayment[]> {
    return (await paymentsRepository.findByPayer(payerId)).map(toPublicPayment);
  },

  /** Admin-only. SUCCESS -> REFUNDED; the conditional update makes a double refund a no-op 409. */
  async refund(paymentId: string): Promise<PublicPayment> {
    const payment = await paymentsRepository.findById(paymentId);
    if (!payment) throw ApiError.notFound("Payment not found");
    if (payment.status !== "SUCCESS") {
      throw ApiError.conflict(`Only SUCCESS payments can be refunded (current: ${payment.status})`);
    }
    if (!payment.provider_reference) throw ApiError.internal("Payment has no provider reference");

    return withLock(`lock:payment-refund:${paymentId}`, async () => {
      const fresh = await paymentsRepository.findById(paymentId);
      if (!fresh || fresh.status !== "SUCCESS") throw ApiError.conflict("Payment was already refunded");

      await getPaymentProvider().refund(fresh.provider_reference!, Number(fresh.amount));
      const refunded = await paymentsRepository.transition(paymentId, ["SUCCESS"], "REFUNDED");
      if (!refunded) throw ApiError.conflict("Payment was already refunded");
      logger.info({ paymentId }, "Payment refunded");
      void notificationsService.notify(refunded.payer_id, "PAYMENT_REFUNDED", refunded.id, { amount: Number(refunded.amount), currency: refunded.currency });
      return toPublicPayment(refunded);
    });
  },
};

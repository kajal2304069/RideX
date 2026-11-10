import { ChargeRequest, ChargeResult, PaymentProvider, RefundResult } from "./PaymentProvider";

/**
 * Placeholder for the real gateway. Intentionally not implemented: it shows
 * where the integration plugs in without adding the Stripe SDK dependency.
 *
 * A real implementation would:
 *   - create a PaymentIntent with `confirm: true`, `payment_method: token`,
 *     and pass `idempotencyKey` as the request's Idempotency-Key option
 *   - map Stripe's `card_error` into { status: "FAILED", failureReason }
 *   - NOT map network errors to FAILED: throw, so PaymentService keeps the
 *     payment PROCESSING and a retry with the same key is safe
 *   - receive final states via signed webhooks (async confirmation, 3DS)
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe" as const;

  constructor(private readonly secretKey: string | undefined) {}

  async charge(_req: ChargeRequest): Promise<ChargeResult> {
    this.assertConfigured();
    throw new Error("StripePaymentProvider.charge is not implemented in this build");
  }

  async refund(_reference: string, _amount: number): Promise<RefundResult> {
    this.assertConfigured();
    throw new Error("StripePaymentProvider.refund is not implemented in this build");
  }

  private assertConfigured() {
    if (!this.secretKey) throw new Error("STRIPE_SECRET_KEY is not configured");
  }
}

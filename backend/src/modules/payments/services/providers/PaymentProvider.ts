/**
 * The seam between RideX and any payment gateway (spec section 16).
 *
 * PaymentService only ever talks to this interface, so swapping the mock
 * for Stripe/Razorpay is a one-file change plus an env var.
 *
 * SECURITY: RideX never sees or stores raw card data. The client tokenizes
 * the card with the provider's SDK and sends us only `paymentMethodToken`
 * (an opaque string). We store only the provider's `reference`.
 */
export interface ChargeRequest {
  amount: number;
  currency: string;
  paymentMethodToken: string;
  /**
   * Forwarded to the provider so that a retried charge call (e.g. after a
   * timeout) is deduplicated on THEIR side too. Real gateways such as
   * Stripe accept an Idempotency-Key for exactly this.
   */
  idempotencyKey: string;
  metadata?: Record<string, string>;
}

export type ChargeResult =
  | { status: "SUCCESS"; reference: string }
  | { status: "FAILED"; reference?: string; failureReason: string };

export interface RefundResult {
  reference: string;
}

export interface PaymentProvider {
  readonly name: "mock" | "stripe";
  charge(req: ChargeRequest): Promise<ChargeResult>;
  refund(reference: string, amount: number): Promise<RefundResult>;
}

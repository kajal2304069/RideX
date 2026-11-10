import { createHash } from "crypto";
import { ChargeRequest, ChargeResult, PaymentProvider, RefundResult } from "./PaymentProvider";

/**
 * Deterministic fake gateway for development and tests.
 *
 * Behaviour is driven by the payment method token, mirroring Stripe's
 * test tokens:
 *   tok_mock_success   -> succeeds (default for any other token too)
 *   tok_mock_decline   -> card declined
 *   tok_mock_funds     -> insufficient funds
 *   tok_mock_error     -> throws (simulates a network error / timeout)
 *
 * The reference is derived from the idempotency key, so a repeated charge
 * with the same key returns the SAME reference, just like a real provider
 * deduplicating on its side.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock" as const;

  /** Number of charge() calls made. Tests use it to prove "exactly one charge". */
  chargeCalls = 0;

  constructor(private readonly latencyMs = 0) {}

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    this.chargeCalls += 1;
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    if (req.paymentMethodToken === "tok_mock_error") {
      throw new Error("Mock provider: network error");
    }
    if (req.paymentMethodToken === "tok_mock_decline") {
      return { status: "FAILED", failureReason: "card_declined" };
    }
    if (req.paymentMethodToken === "tok_mock_funds") {
      return { status: "FAILED", failureReason: "insufficient_funds" };
    }

    const digest = createHash("sha256").update(req.idempotencyKey).digest("hex").slice(0, 16);
    return { status: "SUCCESS", reference: `mock_ch_${digest}` };
  }

  async refund(reference: string): Promise<RefundResult> {
    return { reference: `${reference}_refund` };
  }
}

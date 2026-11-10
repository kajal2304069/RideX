/**
 * The seam between RideX and whatever moves money OUT to a bank account / wallet (Razorpay X, Stripe Connect, UPI...).
 * Kept separate from PaymentProvider (money coming IN) because the failure modes and the compliance rules differ.
 */
export interface PayoutRequest {
  userId: string;
  amount: number;
  currency: string;
  /** Forwarded so a retried call is deduplicated on the provider's side as well. */
  idempotencyKey: string;
}

export type PayoutResult = { status: "SUCCESS"; reference: string } | { status: "FAILED"; failureReason: string };

export interface PayoutProvider {
  readonly name: "mock";
  payout(req: PayoutRequest): Promise<PayoutResult>;
}

/** Deterministic fake. `mode` lets tests simulate a rejected transfer ("decline") or an unknown outcome ("error"). */
export class MockPayoutProvider implements PayoutProvider {
  readonly name = "mock" as const;
  mode: "ok" | "decline" | "error" = "ok";
  calls = 0;

  async payout(req: PayoutRequest): Promise<PayoutResult> {
    this.calls += 1;
    if (this.mode === "error") throw new Error("Mock payout provider: network error");
    if (this.mode === "decline") return { status: "FAILED", failureReason: "bank_account_rejected" };
    return { status: "SUCCESS", reference: `mock_po_${Buffer.from(req.idempotencyKey).toString("hex").slice(0, 16)}` };
  }
}

let instance: PayoutProvider | null = null;
export function getPayoutProvider(): PayoutProvider {
  if (!instance) instance = new MockPayoutProvider();
  return instance;
}
/** Test hook. */
export function setPayoutProviderForTests(p: PayoutProvider | null) {
  instance = p;
}

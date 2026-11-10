export type PayableType = "RIDE" | "RENTAL" | "MARKETPLACE" | "GARAGE_SERVICE";
export type PaymentStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "REFUNDED";
export type PaymentProviderName = "mock" | "stripe";

export interface PaymentRecord {
  id: string;
  payable_type: PayableType;
  payable_id: string;
  payer_id: string;
  amount: string; // numeric(10,2) comes back from pg as a string
  currency: string;
  provider: PaymentProviderName;
  provider_reference: string | null;
  status: PaymentStatus;
  idempotency_key: string;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PublicPayment {
  id: string;
  payableType: PayableType;
  payableId: string;
  payerId: string;
  amount: number;
  currency: string;
  provider: PaymentProviderName;
  providerReference: string | null;
  status: PaymentStatus;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicPayment(p: PaymentRecord): PublicPayment {
  return {
    id: p.id,
    payableType: p.payable_type,
    payableId: p.payable_id,
    payerId: p.payer_id,
    amount: Number(p.amount),
    currency: p.currency,
    provider: p.provider,
    providerReference: p.provider_reference,
    status: p.status,
    failureReason: p.failure_reason,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

/** What a payable resolver tells the PaymentService about the thing being paid for. */
export interface ResolvedPayable {
  /** The user who owes the money. Only this user may pay. */
  payerId: string;
  /** Authoritative amount, computed server-side. Never taken from the client. */
  amount: number;
  currency: string;
}

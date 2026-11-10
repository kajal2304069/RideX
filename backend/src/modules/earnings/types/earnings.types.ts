export type PayoutKind = "EARNINGS_WITHDRAWAL" | "DEPOSIT_REFUND";
export type PayoutStatus = "PENDING" | "PAID" | "FAILED";

export interface PayoutRecord {
  id: string;
  user_id: string;
  kind: PayoutKind;
  amount: string;
  currency: string;
  status: PayoutStatus;
  source_type: "RENTAL" | null;
  source_id: string | null;
  idempotency_key: string;
  provider_reference: string | null;
  failure_reason: string | null;
  created_at: Date;
  paid_at: Date | null;
}

export const toPublicPayout = (p: PayoutRecord) => ({
  id: p.id,
  kind: p.kind,
  amount: Number(p.amount),
  currency: p.currency,
  status: p.status,
  bookingId: p.source_id,
  failureReason: p.failure_reason,
  createdAt: p.created_at,
  paidAt: p.paid_at,
});

export interface DateRange {
  from?: Date;
  to?: Date;
}

export interface SettleRideInput {
  rideId: string;
  rideTotalPaise: number;
  platformPercent: number;
  platform: number; // paise
  owner: { ownerId: string; vehicleId: string; paise: number } | null;
  driver: { driverId: string; paise: number };
}

export interface SettleRentalInput {
  bookingId: string;
  platformPercent: number;
  platform: number; // paise
  owner: { ownerId: string; vehicleId: string; renterId: string; paise: number };
}

export const BOOKING_STATUSES = ["PENDING_PAYMENT", "CONFIRMED", "ACTIVE", "COMPLETED", "CANCELLED", "EXPIRED"] as const;
export type RentalBookingStatus = (typeof BOOKING_STATUSES)[number];
export type CancelledBy = "RENTER" | "OWNER" | "SYSTEM";

export interface RentalListingRecord {
  id: string;
  owner_id: string;
  owner_name: string;
  vehicle_id: string;
  vehicle_type_id: string;
  brand: string;
  model: string;
  year: number;
  fuel_type: string;
  transmission: string;
  hourly_price: string | null;
  daily_price: string | null;
  security_deposit: string;
  lat: number;
  lng: number;
  pickup_address: string | null;
  rules: string | null;
  is_active: boolean;
  distance_meters?: number | null;
  sort_value?: string | null;
  created_at: Date;
  updated_at: Date;
}

export const toPublicRentalListing = (l: RentalListingRecord) => ({
  id: l.id,
  ownerId: l.owner_id,
  ownerName: l.owner_name,
  vehicleId: l.vehicle_id,
  vehicleTypeId: l.vehicle_type_id,
  brand: l.brand,
  model: l.model,
  year: l.year,
  fuelType: l.fuel_type,
  transmission: l.transmission,
  hourlyPrice: l.hourly_price === null ? null : Number(l.hourly_price),
  dailyPrice: l.daily_price === null ? null : Number(l.daily_price),
  securityDeposit: Number(l.security_deposit),
  location: { lat: l.lat, lng: l.lng, address: l.pickup_address },
  rules: l.rules,
  isActive: l.is_active,
  distanceMeters: l.distance_meters ?? null,
  createdAt: l.created_at,
});

export interface RentalBookingRecord {
  id: string;
  rental_listing_id: string;
  renter_id: string;
  owner_id: string;
  vehicle_id: string;
  status: RentalBookingStatus;
  start_at: Date;
  end_at: Date;
  actual_return_at: Date | null;
  total_amount: string;
  deposit_amount: string;
  idempotency_key: string | null;
  payment_due_at: Date | null;
  confirmed_at: Date | null;
  started_at: Date | null;
  cancelled_at: Date | null;
  cancelled_by: CancelledBy | null;
  hourly_rate_at_booking: string;
  late_fee: string;
  damage_deduction: string;
  deposit_refund_due: string | null;
  refund_amount: string;
  return_notes: string | null;
  vehicle_title: string;
  created_at: Date;
  updated_at: Date;
}

export const toPublicBooking = (b: RentalBookingRecord) => ({
  id: b.id,
  listingId: b.rental_listing_id,
  renterId: b.renter_id,
  ownerId: b.owner_id,
  vehicleTitle: b.vehicle_title,
  status: b.status,
  startAt: b.start_at,
  endAt: b.end_at,
  rentAmount: Number(b.total_amount),
  depositAmount: Number(b.deposit_amount),
  totalDue: Math.round((Number(b.total_amount) + Number(b.deposit_amount)) * 100) / 100,
  paymentDueAt: b.payment_due_at,
  confirmedAt: b.confirmed_at,
  startedAt: b.started_at,
  actualReturnAt: b.actual_return_at,
  cancelledAt: b.cancelled_at,
  cancelledBy: b.cancelled_by,
  lateFee: Number(b.late_fee),
  damageDeduction: Number(b.damage_deduction),
  depositRefundDue: b.deposit_refund_due === null ? null : Number(b.deposit_refund_due),
  refundAmount: Number(b.refund_amount),
  returnNotes: b.return_notes,
  createdAt: b.created_at,
});

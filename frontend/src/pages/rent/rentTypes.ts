export interface RentalListing {
  id: string; ownerId: string; ownerName: string; vehicleId: string; brand: string; model: string; year: number; fuelType: string; transmission: string;
  hourlyPrice: number | null; dailyPrice: number | null; securityDeposit: number; location: { lat: number; lng: number; address: string | null }; rules: string | null; isActive: boolean; distanceMeters: number | null;
}
export interface Booking {
  id: string; listingId: string; vehicleTitle: string; status: string; startAt: string; endAt: string; rentAmount: number; depositAmount: number; totalDue: number;
  paymentDueAt: string | null; lateFee: number; damageDeduction: number; depositRefundDue: number | null; refundAmount: number; cancelledBy: string | null;
}
export interface Quote { billedHours: number; days: number; remainingHours: number; rentAmount: number; depositAmount: number; totalDue: number; available: boolean }

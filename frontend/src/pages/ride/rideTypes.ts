export interface Fare { baseFare: number; distanceCharge: number; timeCharge: number; bookingFee: number; surgeMultiplier: number; discount: number; tax: number; totalFare: number; currency: string }
export interface Estimate { distanceMeters: number; durationSeconds: number; fare: Fare; surge: { multiplier: number; demand: number; supply: number } }
export interface DriverCard { id: string; fullName: string; phone: string | null; ratingAvg: number; totalRides: number;
  vehicle: null | { brand: string | null; model: string | null; color: string | null; registrationNumber: string | null; typeName: string | null; typeCode: string | null } }
export interface RiderCard { id: string; fullName: string; phone: string | null }
export interface Ride {
  id: string; riderId: string; driverId: string | null; vehicleId: string | null; vehicleTypeId: string; status: string;
  pickup: { lat: number; lng: number; address: string }; dropoff: { lat: number; lng: number; address: string };
  distanceMeters: number | null; durationSeconds: number | null; requestedAt: string; completedAt: string | null; cancellationReason: string | null;
  surgeMultiplier: number; fare: { totalFare: number; currency: string } | null;
  /** The other person on the ride (the driver, for a rider; the rider, for a driver). A phone number is present only while the ride is live. */
  driver?: DriverCard | null; rider?: RiderCard | null;
}
export interface NearbyDriver { driverId: string; vehicleTypeId: string; lat: number; lng: number; distanceMeters: number }
export interface RoutePath { path: Array<{ nodeId: string; label: string; lat: number; lng: number }>; distanceMeters: number; nodesExplored: number; totalGraphNodes: number; algorithm: { name: string; timeComplexity: string } }
export const ACTIVE_BEFORE_START = ["REQUESTED", "SEARCHING_DRIVER", "DRIVER_ASSIGNED", "DRIVER_ARRIVING", "DRIVER_ARRIVED"];

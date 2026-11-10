export type RideStatus =
  | "REQUESTED"
  | "SEARCHING_DRIVER"
  | "DRIVER_ASSIGNED"
  | "DRIVER_ARRIVING"
  | "DRIVER_ARRIVED"
  | "TRIP_STARTED"
  | "TRIP_COMPLETED"
  | "PAYMENT_COMPLETED"
  | "CANCELLED_BY_RIDER"
  | "CANCELLED_BY_DRIVER"
  | "CANCELLED_BY_SYSTEM";

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface RideRecord {
  id: string;
  rider_id: string;
  driver_id: string | null;
  vehicle_id: string | null;
  vehicle_type_id: string;
  status: RideStatus;
  pickup_lat: number;
  pickup_lng: number;
  pickup_address: string;
  dropoff_lat: number;
  dropoff_lng: number;
  dropoff_address: string;
  idempotency_key: string | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  requested_at: Date;
  accepted_at: Date | null;
  arrived_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  surge_multiplier: string;
  created_at: Date;
  updated_at: Date;
}

export interface RideFareRecord {
  id: string;
  ride_id: string;
  base_fare: string;
  distance_charge: string;
  time_charge: string;
  booking_fee: string;
  surge_multiplier: string;
  discount: string;
  tax: string;
  total_fare: string;
  currency: string;
}

export interface FareBreakdown {
  baseFare: number;
  distanceCharge: number;
  timeCharge: number;
  bookingFee: number;
  surgeMultiplier: number;
  discount: number;
  tax: number;
  totalFare: number;
  currency: string;
}

export interface PublicRide {
  id: string;
  riderId: string;
  driverId: string | null;
  vehicleId: string | null;
  vehicleTypeId: string;
  status: RideStatus;
  pickup: GeoPoint & { address: string };
  dropoff: GeoPoint & { address: string };
  distanceMeters: number | null;
  durationSeconds: number | null;
  requestedAt: Date;
  acceptedAt: Date | null;
  arrivedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  surgeMultiplier: number;
}

export function toPublicRide(r: RideRecord): PublicRide {
  return {
    id: r.id,
    riderId: r.rider_id,
    driverId: r.driver_id,
    vehicleId: r.vehicle_id,
    vehicleTypeId: r.vehicle_type_id,
    status: r.status,
    pickup: { lat: r.pickup_lat, lng: r.pickup_lng, address: r.pickup_address },
    dropoff: { lat: r.dropoff_lat, lng: r.dropoff_lng, address: r.dropoff_address },
    distanceMeters: r.distance_meters,
    durationSeconds: r.duration_seconds,
    requestedAt: r.requested_at,
    acceptedAt: r.accepted_at,
    arrivedAt: r.arrived_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    cancelledAt: r.cancelled_at,
    cancellationReason: r.cancellation_reason,
    surgeMultiplier: Number(r.surge_multiplier),
  };
}

export type VehicleStatus = "AVAILABLE" | "RENTED" | "IN_RIDE_SERVICE" | "UNDER_MAINTENANCE" | "UNAVAILABLE";
export type FuelType = "PETROL" | "DIESEL" | "ELECTRIC" | "HYBRID" | "CNG";
export type TransmissionType = "MANUAL" | "AUTOMATIC";

export interface VehicleRecord {
  id: string;
  owner_id: string;
  vehicle_type_id: string;
  registration_number: string;
  brand: string;
  model: string;
  year: number;
  color: string | null;
  fuel_type: FuelType;
  transmission: TransmissionType;
  mileage_km: number;
  status: VehicleStatus;
  current_driver_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PublicVehicle {
  id: string;
  ownerId: string;
  vehicleTypeId: string;
  registrationNumber: string;
  brand: string;
  model: string;
  year: number;
  color: string | null;
  fuelType: FuelType;
  transmission: TransmissionType;
  mileageKm: number;
  status: VehicleStatus;
  currentDriverId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicVehicle(v: VehicleRecord): PublicVehicle {
  return {
    id: v.id,
    ownerId: v.owner_id,
    vehicleTypeId: v.vehicle_type_id,
    registrationNumber: v.registration_number,
    brand: v.brand,
    model: v.model,
    year: v.year,
    color: v.color,
    fuelType: v.fuel_type,
    transmission: v.transmission,
    mileageKm: v.mileage_km,
    status: v.status,
    currentDriverId: v.current_driver_id,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
  };
}

export interface AssignmentRecord {
  id: string;
  vehicle_id: string;
  driver_id: string;
  owner_id: string;
  commission_percent: string;
  owner_share_percent: string;
  status: "ACTIVE" | "ENDED";
  started_at: Date;
  ended_at: Date | null;
}

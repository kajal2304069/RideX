export type VerificationStatus = "PENDING" | "VERIFIED" | "REJECTED";

export interface DriverRecord {
  user_id: string;
  license_number: string;
  license_expiry: string; // date comes back as 'YYYY-MM-DD' string from pg
  verification_status: VerificationStatus;
  is_online: boolean;
  current_vehicle_id: string | null;
  rating_avg: string;
  total_rides: number;
  created_at: Date;
  updated_at: Date;
}

export interface PublicDriverProfile {
  userId: string;
  licenseNumber: string;
  licenseExpiry: string;
  verificationStatus: VerificationStatus;
  isOnline: boolean;
  currentVehicleId: string | null;
  ratingAvg: number;
  totalRides: number;
  createdAt: Date;
}

export function toPublicDriverProfile(driver: DriverRecord): PublicDriverProfile {
  return {
    userId: driver.user_id,
    licenseNumber: driver.license_number,
    licenseExpiry: driver.license_expiry,
    verificationStatus: driver.verification_status,
    isOnline: driver.is_online,
    currentVehicleId: driver.current_vehicle_id,
    ratingAvg: Number(driver.rating_avg),
    totalRides: driver.total_rides,
    createdAt: driver.created_at,
  };
}

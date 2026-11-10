export interface DriverLocationUpdate {
  lat: number;
  lng: number;
  heading?: number;
  speedKmh?: number;
}

export interface NearbyDriver {
  driverId: string;
  vehicleId: string;
  vehicleTypeId: string;
  lat: number;
  lng: number;
  distanceMeters: number;
  heading: number | null;
  speedKmh: number | null;
  updatedAt: number; // unix ms
}

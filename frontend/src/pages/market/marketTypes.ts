export interface Listing {
  id: string; seller: { id: string; name: string }; vehicleTypeId: string; brand: string; model: string; year: number;
  mileageKm: number; fuelType: string; transmission: string; condition: string; ownerCount: number; price: number;
  location: { lat: number; lng: number }; address: string | null; description: string | null; insuranceValidUntil: string | null;
  status: string; isReserved: boolean; createdAt: string; thumbnail: string | null; images?: Array<{ id: string; url: string }>;
  distanceMeters?: number; isFavorite?: boolean;
}
export interface Offer { id: string; listingId: string; buyerId?: string; buyer?: { id: string; name: string }; amount: number; status: string; createdAt: string; listing?: Partial<Listing> }
export const FUELS = ["PETROL", "DIESEL", "ELECTRIC", "CNG", "HYBRID"];
export const TRANSMISSIONS = ["MANUAL", "AUTOMATIC"];
export const CONDITIONS = ["NEW", "EXCELLENT", "GOOD", "FAIR", "NEEDS_WORK"];

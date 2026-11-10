export type ListingStatus = "ACTIVE" | "SOLD" | "DELISTED";
export type ListingCondition = "NEW" | "EXCELLENT" | "GOOD" | "FAIR" | "NEEDS_WORK";
export type OfferStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "WITHDRAWN" | "EXPIRED";
export type InspectionStatus = "SCHEDULED" | "COMPLETED" | "CANCELLED";
export type FuelType = "PETROL" | "DIESEL" | "ELECTRIC" | "HYBRID" | "CNG";
export type TransmissionType = "MANUAL" | "AUTOMATIC";

export const LISTING_CONDITIONS: [ListingCondition, ...ListingCondition[]] = ["NEW", "EXCELLENT", "GOOD", "FAIR", "NEEDS_WORK"];
export const FUEL_TYPES: [FuelType, ...FuelType[]] = ["PETROL", "DIESEL", "ELECTRIC", "HYBRID", "CNG"];
export const TRANSMISSIONS: [TransmissionType, ...TransmissionType[]] = ["MANUAL", "AUTOMATIC"];

export interface ListingRecord {
  id: string;
  seller_id: string;
  seller_name: string;
  vehicle_type_id: string;
  brand: string;
  model: string;
  year: number;
  mileage_km: number;
  fuel_type: FuelType;
  transmission: TransmissionType;
  condition: ListingCondition;
  owner_count: number;
  price: string;
  lat: number;
  lng: number;
  address: string | null;
  description: string | null;
  insurance_valid_until: string | null;
  status: ListingStatus;
  created_at: Date;
  updated_at: Date;
  is_reserved: boolean;
  /** Search results only */
  distance_meters?: number | null;
  thumbnail?: string | null;
  sort_value?: string;
}

export interface ImageRecord {
  id: string;
  listing_id: string;
  url: string;
  position: number;
}

export interface OfferRecord {
  id: string;
  listing_id: string;
  buyer_id: string;
  offer_amount: string;
  status: OfferStatus;
  accepted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** joined */
  seller_id: string;
  listing_price: string;
  listing_status: ListingStatus;
  listing_title: string;
}

export interface InspectionReport {
  engine: { score: number; notes?: string };
  brakes: { score: number; notes?: string };
  tyres: { score: number; notes?: string };
  battery: { score: number; notes?: string };
  body: { score: number; notes?: string };
  electrical: { score: number; notes?: string };
  documents: { verified: boolean; notes?: string };
  accidentHistory: { hadAccident: boolean; details?: string };
  /** Computed by the server: mean of the six scored categories, 1 decimal. Never client-supplied. */
  overallScore?: number;
  flags?: string[];
}

export interface InspectionRecord {
  id: string;
  listing_id: string;
  buyer_id: string;
  inspector_id: string | null;
  scheduled_at: Date;
  status: InspectionStatus;
  report: InspectionReport | null;
  created_at: Date;
  seller_id: string;
}

export const toPublicListing = (l: ListingRecord) => ({
  id: l.id,
  seller: { id: l.seller_id, name: l.seller_name },
  vehicleTypeId: l.vehicle_type_id,
  brand: l.brand,
  model: l.model,
  year: l.year,
  mileageKm: l.mileage_km,
  fuelType: l.fuel_type,
  transmission: l.transmission,
  condition: l.condition,
  ownerCount: l.owner_count,
  price: Number(l.price),
  location: { lat: l.lat, lng: l.lng },
  address: l.address,
  description: l.description,
  insuranceValidUntil: l.insurance_valid_until,
  status: l.status,
  isReserved: l.is_reserved,
  createdAt: l.created_at,
  ...(l.distance_meters !== undefined && l.distance_meters !== null ? { distanceMeters: Math.round(l.distance_meters) } : {}),
  ...(l.thumbnail !== undefined ? { thumbnail: l.thumbnail } : {}),
});

export const toPublicImage = (i: ImageRecord) => ({ id: i.id, url: i.url, position: i.position });

export const toPublicOffer = (o: OfferRecord) => ({
  id: o.id,
  listingId: o.listing_id,
  listingTitle: o.listing_title,
  buyerId: o.buyer_id,
  amount: Number(o.offer_amount),
  askingPrice: Number(o.listing_price),
  status: o.status,
  acceptedAt: o.accepted_at,
  createdAt: o.created_at,
});

export const toPublicInspection = (i: InspectionRecord) => ({
  id: i.id,
  listingId: i.listing_id,
  buyerId: i.buyer_id,
  inspectorId: i.inspector_id,
  scheduledAt: i.scheduled_at,
  status: i.status,
  report: i.report,
  createdAt: i.created_at,
});

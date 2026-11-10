export type GarageServiceType =
  | "OIL_CHANGE" | "BRAKE_REPAIR" | "ENGINE_REPAIR" | "TYRE_REPLACEMENT" | "BATTERY_REPLACEMENT"
  | "GENERAL_SERVICE" | "ELECTRICAL_REPAIR" | "AC_REPAIR" | "BODY_WORK" | "EMERGENCY_REPAIR";

export const GARAGE_SERVICE_TYPES: [GarageServiceType, ...GarageServiceType[]] = [
  "OIL_CHANGE", "BRAKE_REPAIR", "ENGINE_REPAIR", "TYRE_REPLACEMENT", "BATTERY_REPLACEMENT",
  "GENERAL_SERVICE", "ELECTRICAL_REPAIR", "AC_REPAIR", "BODY_WORK", "EMERGENCY_REPAIR",
];

export interface GarageRecord {
  id: string;
  owner_id: string;
  name: string;
  lat: number;
  lng: number;
  address: string;
  phone: string | null;
  opening_hours: Record<string, string> | null;
  price_range: string | null;
  rating_avg: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  /** Present only on nearby-search results. */
  distance_meters?: number;
  service_types?: GarageServiceType[];
}

export interface GarageServiceRecord {
  id: string;
  garage_id: string;
  service_type: GarageServiceType;
  price_from: string | null;
  price_to: string | null;
  estimated_duration_minutes: number | null;
}

export interface MechanicRecord {
  id: string;
  garage_id: string;
  user_id: string | null;
  name: string;
  specialization: string | null;
  is_active: boolean;
}

export interface PublicGarage {
  id: string;
  ownerId: string;
  name: string;
  location: { lat: number; lng: number };
  address: string;
  phone: string | null;
  openingHours: Record<string, string> | null;
  priceRange: string | null;
  ratingAvg: number;
  isActive: boolean;
  distanceMeters?: number;
  serviceTypes?: GarageServiceType[];
}

export function toPublicGarage(g: GarageRecord): PublicGarage {
  return {
    id: g.id,
    ownerId: g.owner_id,
    name: g.name,
    location: { lat: g.lat, lng: g.lng },
    address: g.address,
    phone: g.phone,
    openingHours: g.opening_hours,
    priceRange: g.price_range,
    ratingAvg: Number(g.rating_avg),
    isActive: g.is_active,
    ...(g.distance_meters !== undefined ? { distanceMeters: Math.round(g.distance_meters) } : {}),
    ...(g.service_types ? { serviceTypes: g.service_types } : {}),
  };
}

export function toPublicService(s: GarageServiceRecord) {
  return {
    id: s.id,
    garageId: s.garage_id,
    serviceType: s.service_type,
    priceFrom: s.price_from === null ? null : Number(s.price_from),
    priceTo: s.price_to === null ? null : Number(s.price_to),
    estimatedDurationMinutes: s.estimated_duration_minutes,
  };
}

export function toPublicMechanic(m: MechanicRecord) {
  return { id: m.id, garageId: m.garage_id, userId: m.user_id, name: m.name, specialization: m.specialization, isActive: m.is_active };
}

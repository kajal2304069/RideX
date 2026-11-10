import { FareBreakdown, GeoPoint } from "../types/rides.types";

const EARTH_RADIUS_METERS = 6371000;

/**
 * Straight-line (great-circle) distance between two points. This is
 * deliberately NOT the Dijkstra road-network routing engine (that's
 * Phase 8) - it's the fast, good-enough estimate used for the upfront
 * fare quote shown before a rider commits to requesting a ride. Once
 * Phase 8 lands, the actual trip fare (computed at completion) can use
 * the routed distance instead; this estimate only needs to be close
 * enough to set rider expectations, not billing-accurate.
 */
export function haversineDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_METERS * c;
}

/** Crude duration estimate from distance, assuming average urban traffic speed. Same "good enough for a quote" caveat as distance above. */
const ASSUMED_AVG_SPEED_KMH = 25;
export function estimateDurationSeconds(distanceMeters: number): number {
  const speedMps = (ASSUMED_AVG_SPEED_KMH * 1000) / 3600;
  return Math.round(distanceMeters / speedMps);
}

const TAX_RATE = 0.05; // 5% flat tax, configurable in one place
const BOOKING_FEE = 5;

export interface VehicleTypeRates {
  baseFare: number;
  perKmRate: number;
  perMinRate: number;
}

/**
 * Pure function: (distance, duration, vehicle type rates, surge) -> a
 * full fare breakdown (spec section 14). No DB, no I/O - vehicle type
 * rates are passed in by the caller (repository lookup happens in the
 * service layer), which is what makes this trivially unit-testable
 * with made-up rate numbers instead of needing seeded DB rows.
 */
export function computeFare(
  distanceMeters: number,
  durationSeconds: number,
  rates: VehicleTypeRates,
  options: { surgeMultiplier?: number; discount?: number } = {}
): FareBreakdown {
  const surgeMultiplier = options.surgeMultiplier ?? 1.0;
  const discount = options.discount ?? 0;

  const distanceKm = distanceMeters / 1000;
  const durationMin = durationSeconds / 60;

  const baseFare = rates.baseFare;
  const distanceCharge = round2(distanceKm * rates.perKmRate);
  const timeCharge = round2(durationMin * rates.perMinRate);
  const bookingFee = BOOKING_FEE;

  const subtotal = (baseFare + distanceCharge + timeCharge + bookingFee) * surgeMultiplier;
  const afterDiscount = Math.max(0, subtotal - discount);
  const tax = round2(afterDiscount * TAX_RATE);
  const totalFare = round2(afterDiscount + tax);

  return {
    baseFare: round2(baseFare),
    distanceCharge,
    timeCharge,
    bookingFee: round2(bookingFee),
    surgeMultiplier,
    discount: round2(discount),
    tax,
    totalFare,
    currency: "INR",
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

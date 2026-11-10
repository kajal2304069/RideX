import { ApiError } from "../../../common/ApiError";
import { vehiclesRepository } from "../../vehicles/repositories/vehicles.repository";
import { RentalSearchFilters, RentalSortKey, rentalListingsRepository } from "../repositories/rentalListings.repository";
import { rentalBookingsRepository } from "../repositories/rentalBookings.repository";
import { RentalListingRecord, toPublicRentalListing } from "../types/rentals.types";
import { calculateRentalPrice } from "./rentalPricing";
import { assertValidWindow } from "./rentalRules";

const isPgCode = (err: unknown, code: string) => typeof err === "object" && err !== null && (err as { code?: string }).code === code;

/** Cursor = base64url(JSON{ s: sort, v: sortValueAsText, id }). Opaque to clients. */
function encodeCursor(sort: RentalSortKey, v: string, id: string): string {
  return Buffer.from(JSON.stringify({ s: sort, v, id })).toString("base64url");
}
function decodeCursor(raw: string, sort: RentalSortKey): { v: string; id: string } {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { s: string; v: string; id: string };
    if (c.s !== sort || typeof c.v !== "string" || !/^[0-9a-f-]{36}$/i.test(c.id)) throw new Error("bad cursor");
    return { v: c.v, id: c.id };
  } catch {
    throw ApiError.badRequest("Invalid or mismatched cursor");
  }
}

async function loadOwnListing(listingId: string, ownerId: string): Promise<RentalListingRecord> {
  const l = await rentalListingsRepository.findById(listingId);
  if (!l || l.owner_id !== ownerId) throw ApiError.notFound("Rental listing not found"); // 404, not 403
  return l;
}

const rates = (l: RentalListingRecord) => ({
  hourlyPrice: l.hourly_price === null ? null : Number(l.hourly_price),
  dailyPrice: l.daily_price === null ? null : Number(l.daily_price),
});

export interface CreateRentalListingInput {
  vehicleId: string;
  hourlyPrice?: number;
  dailyPrice?: number;
  securityDeposit: number;
  lat: number;
  lng: number;
  address?: string;
  rules?: string;
}

export const rentalListingsService = {
  async create(ownerId: string, input: CreateRentalListingInput) {
    const vehicle = await vehiclesRepository.findById(input.vehicleId);
    if (!vehicle || vehicle.owner_id !== ownerId) throw ApiError.notFound("Vehicle not found");

    const category = await rentalListingsRepository.vehicleTypeCategory(vehicle.vehicle_type_id);
    if (category !== "RENTAL" && category !== "BOTH") throw ApiError.badRequest("This type of vehicle cannot be rented out");
    if (vehicle.status === "UNAVAILABLE") throw ApiError.conflict("An unavailable vehicle cannot be listed for rent");

    try {
      const l = await rentalListingsRepository.create({
        ownerId, vehicleId: input.vehicleId, hourlyPrice: input.hourlyPrice ?? null, dailyPrice: input.dailyPrice ?? null,
        securityDeposit: input.securityDeposit, lat: input.lat, lng: input.lng, address: input.address, rules: input.rules,
      });
      return toPublicRentalListing(l);
    } catch (err) {
      if (isPgCode(err, "23505")) throw ApiError.conflict("This vehicle already has a rental listing");
      if (isPgCode(err, "23503")) throw ApiError.notFound("Vehicle not found"); // composite FK: not your vehicle
      throw err;
    }
  },

  async update(listingId: string, ownerId: string, f: {
    hourlyPrice?: number | null; dailyPrice?: number | null; securityDeposit?: number; lat?: number; lng?: number;
    address?: string | null; rules?: string | null;
  }) {
    const l = await loadOwnListing(listingId, ownerId);
    // After the edit the listing must still have at least one price. (Existing bookings keep the price they were made at.)
    const hourly = f.hourlyPrice === undefined ? l.hourly_price : f.hourlyPrice;
    const daily = f.dailyPrice === undefined ? l.daily_price : f.dailyPrice;
    if (hourly === null && daily === null) throw ApiError.badRequest("A listing needs an hourly price, a daily price, or both");
    return toPublicRentalListing((await rentalListingsRepository.update(listingId, f))!);
  },

  /** Hide/show a listing. Existing bookings are honoured either way; only NEW bookings and search are affected. */
  async setActive(listingId: string, ownerId: string, active: boolean) {
    await loadOwnListing(listingId, ownerId);
    return toPublicRentalListing((await rentalListingsRepository.setActive(listingId, active))!);
  },

  async mine(ownerId: string) {
    return (await rentalListingsRepository.listByOwner(ownerId)).map(toPublicRentalListing);
  },

  /** Active listings are public. An inactive one is visible only to its owner and admins (404 for everyone else). */
  async getOne(listingId: string, viewerId: string | undefined, isAdmin: boolean) {
    const l = await rentalListingsRepository.findById(listingId);
    if (!l || (!l.is_active && l.owner_id !== viewerId && !isAdmin)) throw ApiError.notFound("Rental listing not found");
    return { listing: toPublicRentalListing(l) };
  },

  async search(input: { filters: RentalSearchFilters; sort: RentalSortKey; cursor?: string; limit: number }) {
    if (input.sort === "distance" && !input.filters.near) throw ApiError.badRequest("Sorting by distance needs lat and lng");
    const cursor = input.cursor ? decodeCursor(input.cursor, input.sort) : undefined;
    const rows = await rentalListingsRepository.search({ filters: input.filters, sort: input.sort, cursor, limit: input.limit + 1 });
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > input.limit && last ? encodeCursor(input.sort, last.sort_value!, last.id) : null;
    return { listings: page.map(toPublicRentalListing), nextCursor };
  },

  /** Time ranges that cannot be booked, with no renter details. Window capped at 90 days. */
  async availability(listingId: string, from: Date, to: Date) {
    const l = await rentalListingsRepository.findById(listingId);
    if (!l || !l.is_active) throw ApiError.notFound("Rental listing not found");
    const ranges = await rentalBookingsRepository.blockedRanges(listingId, from, to);
    return { listingId, from, to, blocked: ranges.map((r) => ({ startAt: r.start_at, endAt: r.end_at })) };
  },

  /** Price + availability for a window, without creating anything. Uses exactly the rules a booking would. */
  async quote(listingId: string, start: Date, end: Date) {
    const l = await rentalListingsRepository.findById(listingId);
    if (!l || !l.is_active) throw ApiError.notFound("Rental listing not found");
    assertValidWindow(start, end);
    const q = calculateRentalPrice(start, end, rates(l));
    const blocked = await rentalBookingsRepository.blockedRanges(listingId, start, end);
    const deposit = Number(l.security_deposit);
    return {
      listingId,
      startAt: start,
      endAt: end,
      billedHours: q.billedHours,
      days: q.days,
      remainingHours: q.remainingHours,
      rentAmount: q.rent,
      depositAmount: deposit,
      totalDue: Math.round((q.rent + deposit) * 100) / 100,
      available: blocked.length === 0,
    };
  },
};

export { rates as listingRates };

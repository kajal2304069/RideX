import { z } from "zod";

const uuid = z.string().uuid();
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const price = z.number().positive().max(10_000_000);
const FUEL = ["PETROL", "DIESEL", "ELECTRIC", "HYBRID", "CNG"] as const;
const TRANSMISSION = ["MANUAL", "AUTOMATIC"] as const;

export const createRentalListingSchema = z.object({
  body: z.object({
    vehicleId: uuid,
    hourlyPrice: price.optional(),
    dailyPrice: price.optional(),
    securityDeposit: z.number().min(0).max(10_000_000).default(0),
    lat, lng,
    address: z.string().max(300).optional(),
    rules: z.string().max(2000).optional(),
  }).strict().refine((b) => b.hourlyPrice !== undefined || b.dailyPrice !== undefined, "Provide an hourly price, a daily price, or both"),
});

export const updateRentalListingSchema = z.object({
  params: z.object({ listingId: uuid }),
  body: z.object({
    hourlyPrice: price.nullable().optional(),
    dailyPrice: price.nullable().optional(),
    securityDeposit: z.number().min(0).max(10_000_000).optional(),
    lat: lat.optional(),
    lng: lng.optional(),
    address: z.string().max(300).nullable().optional(),
    rules: z.string().max(2000).nullable().optional(),
  }).strict()
    .refine((b) => Object.keys(b).length > 0, "Nothing to update")
    .refine((b) => (b.lat === undefined) === (b.lng === undefined), "Provide lat and lng together"),
});

export const listingIdParamSchema = z.object({ params: z.object({ listingId: uuid }) });
export const bookingIdParamSchema = z.object({ params: z.object({ bookingId: uuid }) });

export const searchRentalsSchema = z.object({
  query: z.object({
    q: z.string().trim().min(1).max(80).optional(),
    vehicleTypeId: uuid.optional(),
    fuelType: z.enum(FUEL).optional(),
    transmission: z.enum(TRANSMISSION).optional(),
    minDailyPrice: z.coerce.number().min(0).optional(),
    maxDailyPrice: z.coerce.number().min(0).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusMeters: z.coerce.number().int().min(100).max(100_000).default(10_000),
    availableFrom: z.coerce.date().optional(),
    availableTo: z.coerce.date().optional(),
    sort: z.enum(["newest", "price_asc", "distance"]).default("newest"),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }).refine((q) => (q.lat === undefined) === (q.lng === undefined), "Provide lat and lng together")
    .refine((q) => (q.availableFrom === undefined) === (q.availableTo === undefined), "Provide availableFrom and availableTo together")
    .refine((q) => !q.availableFrom || !q.availableTo || q.availableTo > q.availableFrom, "availableTo must be after availableFrom")
    .refine((q) => q.minDailyPrice === undefined || q.maxDailyPrice === undefined || q.minDailyPrice <= q.maxDailyPrice, "minDailyPrice cannot exceed maxDailyPrice"),
});

export const quoteSchema = z.object({
  params: z.object({ listingId: uuid }),
  query: z.object({ startAt: z.coerce.date(), endAt: z.coerce.date() }),
});

export const availabilitySchema = z.object({
  params: z.object({ listingId: uuid }),
  query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() })
    .refine((q) => !q.from || !q.to || (q.to > q.from && q.to.getTime() - q.from.getTime() <= 90 * 86_400_000), "Window must be positive and at most 90 days"),
});

export const bookSchema = z.object({
  params: z.object({ listingId: uuid }),
  body: z.object({
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    idempotencyKey: z.string().min(8).max(100),
  }).strict(),
});

export const completeSchema = z.object({
  params: z.object({ bookingId: uuid }),
  body: z.object({
    damageDeduction: z.number().min(0).max(10_000_000).optional(),
    notes: z.string().max(1000).optional(),
  }).strict(),
});

export const ownerBookingsSchema = z.object({ query: z.object({ listingId: uuid.optional() }) });

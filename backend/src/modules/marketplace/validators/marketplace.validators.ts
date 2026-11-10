import { z } from "zod";
import { FUEL_TYPES, LISTING_CONDITIONS, TRANSMISSIONS } from "../types/marketplace.types";

const uuid = z.string().uuid();
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const thisYear = new Date().getFullYear();
const money = z.number().positive().max(100_000_000);
const httpsUrl = z.string().url().max(500).refine((u) => u.startsWith("https://"), "Image URLs must be https");

export const createListingSchema = z.object({
  body: z.object({
    vehicleTypeId: uuid,
    brand: z.string().min(1).max(60),
    model: z.string().min(1).max(60),
    year: z.number().int().min(1950).max(thisYear + 1),
    mileageKm: z.number().int().min(0).max(2_000_000),
    fuelType: z.enum(FUEL_TYPES),
    transmission: z.enum(TRANSMISSIONS),
    condition: z.enum(LISTING_CONDITIONS).default("GOOD"),
    ownerCount: z.number().int().min(1).max(20).default(1),
    price: money,
    lat, lng,
    address: z.string().max(300).optional(),
    description: z.string().max(4000).optional(),
    insuranceValidUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  }).strict(),
});

export const updateListingSchema = z.object({
  params: z.object({ listingId: uuid }),
  body: z.object({
    price: money.optional(),
    mileageKm: z.number().int().min(0).max(2_000_000).optional(),
    condition: z.enum(LISTING_CONDITIONS).optional(),
    ownerCount: z.number().int().min(1).max(20).optional(),
    description: z.string().max(4000).nullable().optional(),
    address: z.string().max(300).nullable().optional(),
    insuranceValidUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    lat: lat.optional(),
    lng: lng.optional(),
  }).strict()
    .refine((b) => (b.lat === undefined) === (b.lng === undefined), "Provide lat and lng together")
    .refine((b) => Object.keys(b).length > 0, "Nothing to update"),
});

export const searchListingsSchema = z.object({
  query: z.object({
    q: z.string().trim().min(1).max(80).optional(),
    brand: z.string().trim().min(1).max(60).optional(),
    vehicleTypeId: uuid.optional(),
    minPrice: z.coerce.number().min(0).optional(),
    maxPrice: z.coerce.number().min(0).optional(),
    minYear: z.coerce.number().int().min(1950).optional(),
    maxYear: z.coerce.number().int().max(2100).optional(),
    maxMileage: z.coerce.number().int().min(0).optional(),
    // comma separated: ?condition=EXCELLENT,GOOD
    condition: z.string().transform((s) => s.split(",").map((x) => x.trim())).pipe(z.array(z.enum(LISTING_CONDITIONS)).min(1).max(4)).optional(),
    fuelType: z.enum(FUEL_TYPES).optional(),
    transmission: z.enum(TRANSMISSIONS).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusMeters: z.coerce.number().int().min(100).max(200_000).default(25_000),
    sort: z.enum(["newest", "price_asc", "price_desc", "distance"]).default("newest"),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }).refine((q) => (q.lat === undefined) === (q.lng === undefined), "Provide lat and lng together")
    .refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, "minPrice cannot exceed maxPrice")
    .refine((q) => q.minYear === undefined || q.maxYear === undefined || q.minYear <= q.maxYear, "minYear cannot exceed maxYear"),
});

export const listingIdParamSchema = z.object({ params: z.object({ listingId: uuid }) });

export const addImageSchema = z.object({
  params: z.object({ listingId: uuid }),
  body: z.object({ url: httpsUrl, position: z.number().int().min(0).max(9).optional() }).strict(),
});
export const imageParamSchema = z.object({ params: z.object({ listingId: uuid, imageId: uuid }) });

export const createOfferSchema = z.object({
  params: z.object({ listingId: uuid }),
  body: z.object({ amount: money }).strict(),
});
export const listingOffersSchema = z.object({
  params: z.object({ listingId: uuid }),
  query: z.object({ status: z.enum(["PENDING", "ACCEPTED", "REJECTED", "WITHDRAWN", "EXPIRED"]).optional() }),
});
export const offerIdParamSchema = z.object({ params: z.object({ offerId: uuid }) });

export const scheduleInspectionSchema = z.object({
  params: z.object({ listingId: uuid }),
  body: z.object({ scheduledAt: z.coerce.date() }).strict(),
});
export const inspectionIdParamSchema = z.object({ params: z.object({ inspectionId: uuid }) });

const scored = z.object({ score: z.number().int().min(1).max(10), notes: z.string().max(1000).optional() }).strict();
export const submitReportSchema = z.object({
  params: z.object({ inspectionId: uuid }),
  body: z.object({
    engine: scored, brakes: scored, tyres: scored, battery: scored, body: scored, electrical: scored,
    documents: z.object({ verified: z.boolean(), notes: z.string().max(1000).optional() }).strict(),
    accidentHistory: z.object({ hadAccident: z.boolean(), details: z.string().max(1000).optional() }).strict(),
    // No overallScore / flags: the server derives them.
  }).strict(),
});

import { z } from "zod";
import { GARAGE_SERVICE_TYPES } from "../types/garages.types";

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const openingHours = z
  .record(z.enum(days), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM-HH:MM"))
  .refine((o) => Object.keys(o).length > 0, "At least one day");

const uuid = z.string().uuid();

export const createGarageSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(120),
    lat, lng,
    address: z.string().min(3).max(300),
    phone: z.string().min(7).max(20).optional(),
    openingHours: openingHours.optional(),
    priceRange: z.string().max(40).optional(),
  }).strict(),
});

export const updateGarageSchema = z.object({
  params: z.object({ garageId: uuid }),
  body: z.object({
    name: z.string().min(2).max(120).optional(),
    address: z.string().min(3).max(300).optional(),
    phone: z.string().min(7).max(20).nullable().optional(),
    openingHours: openingHours.nullable().optional(),
    priceRange: z.string().max(40).nullable().optional(),
    isActive: z.boolean().optional(),
    lat: lat.optional(),
    lng: lng.optional(),
  }).strict().refine((b) => (b.lat === undefined) === (b.lng === undefined), "Provide lat and lng together")
    .refine((b) => Object.keys(b).length > 0, "Nothing to update"),
});

export const nearbyGaragesSchema = z.object({
  query: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    radiusMeters: z.coerce.number().int().min(100).max(50000).default(5000),
    serviceType: z.enum(GARAGE_SERVICE_TYPES).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
});

export const garageIdParamSchema = z.object({ params: z.object({ garageId: uuid }) });

export const addServiceSchema = z.object({
  params: z.object({ garageId: uuid }),
  body: z.object({
    serviceType: z.enum(GARAGE_SERVICE_TYPES),
    priceFrom: z.number().min(0).max(1_000_000).optional(),
    priceTo: z.number().min(0).max(1_000_000).optional(),
    estimatedDurationMinutes: z.number().int().min(5).max(60 * 24 * 14).optional(),
  }).strict(),
});

export const serviceParamSchema = z.object({ params: z.object({ garageId: uuid, serviceId: uuid }) });

export const addMechanicSchema = z.object({
  params: z.object({ garageId: uuid }),
  body: z.object({
    name: z.string().min(2).max(100),
    specialization: z.string().max(100).optional(),
    userId: uuid.optional(),
  }).strict(),
});

export const mechanicActiveSchema = z.object({
  params: z.object({ garageId: uuid, mechanicId: uuid }),
  body: z.object({ isActive: z.boolean() }).strict(),
});

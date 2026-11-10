import { z } from "zod";

export const updateLocationSchema = z.object({
  body: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    heading: z.number().min(0).max(360).optional(),
    speedKmh: z.number().min(0).max(300).optional(),
  }),
});

export const nearbyDriversSchema = z.object({
  query: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    radiusMeters: z.coerce.number().min(100).max(20000).default(2000),
    vehicleTypeId: z.string().uuid().optional(),
  }),
});

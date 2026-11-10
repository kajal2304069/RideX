import { z } from "zod";

const geoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const estimateRideSchema = z.object({
  body: z.object({
    pickup: geoPoint,
    dropoff: geoPoint,
    vehicleTypeId: z.string().uuid(),
  }),
});

export const requestRideSchema = z.object({
  body: z.object({
    pickup: geoPoint.extend({ address: z.string().min(1).max(300) }),
    dropoff: geoPoint.extend({ address: z.string().min(1).max(300) }),
    vehicleTypeId: z.string().uuid(),
    // Client-supplied idempotency key (spec section 13) - a retried
    // "request ride" call (flaky network, double-tap) with the same key
    // returns the original ride instead of creating a duplicate.
    idempotencyKey: z.string().min(8).max(100),
  }),
});

export const rideIdParamSchema = z.object({
  params: z.object({ rideId: z.string().uuid() }),
});

export const cancelRideSchema = z.object({
  params: z.object({ rideId: z.string().uuid() }),
  body: z.object({
    reason: z.string().max(300).optional(),
  }),
});

export const rateRideSchema = z.object({
  params: z.object({ rideId: z.string().uuid() }),
  body: z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(500).optional() }).strict(),
});

import { z } from "zod";

const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(100);
const money = z.number().min(0).max(1_000_000);
const STATUSES = ["REQUESTED", "ACCEPTED", "MECHANIC_ASSIGNED", "VEHICLE_RECEIVED", "REPAIR_IN_PROGRESS", "READY", "COMPLETED", "CANCELLED"] as const;

export const createBookingSchema = z.object({
  body: z.object({
    garageId: uuid,
    garageServiceId: uuid.optional(),
    vehicleId: uuid.optional(),
    scheduledAt: z.coerce.date().optional(),
    description: z.string().max(500).optional(),
    idempotencyKey,
  }).strict(),
});

export const emergencySchema = z.object({
  body: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    vehicleId: uuid.optional(),
    description: z.string().max(500).optional(),
    idempotencyKey,
  }).strict(),
});

export const bookingIdParamSchema = z.object({ params: z.object({ bookingId: uuid }) });

export const assignMechanicSchema = z.object({
  params: z.object({ bookingId: uuid }),
  body: z.object({ mechanicId: uuid }).strict(),
});

export const repairOrderSchema = z.object({
  params: z.object({ bookingId: uuid }),
  body: z.object({
    diagnosis: z.string().max(2000).optional(),
    workPerformed: z.string().max(2000).optional(),
    partsUsed: z.array(z.object({
      name: z.string().min(1).max(120),
      quantity: z.number().int().min(1).max(1000),
      unitPrice: money,
    }).strict()).max(50).optional(),
    laborCost: money,
    // No partsCost / totalCost: the server computes them.
  }).strict(),
});

export const garageBookingsSchema = z.object({
  params: z.object({ garageId: uuid }),
  query: z.object({ status: z.enum(STATUSES).optional() }),
});

export const vehicleIdParamSchema = z.object({ params: z.object({ vehicleId: uuid }) });

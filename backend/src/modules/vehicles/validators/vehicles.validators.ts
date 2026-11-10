import { z } from "zod";

const FUEL_TYPES = ["PETROL", "DIESEL", "ELECTRIC", "HYBRID", "CNG"] as const;
const TRANSMISSIONS = ["MANUAL", "AUTOMATIC"] as const;
const STATUSES = ["AVAILABLE", "RENTED", "IN_RIDE_SERVICE", "UNDER_MAINTENANCE", "UNAVAILABLE"] as const;

export const createVehicleSchema = z.object({
  body: z.object({
    vehicleTypeId: z.string().uuid(),
    registrationNumber: z.string().min(4).max(20),
    brand: z.string().min(1).max(50),
    model: z.string().min(1).max(50),
    year: z.number().int().min(1980).max(new Date().getFullYear() + 1),
    color: z.string().max(30).optional(),
    fuelType: z.enum(FUEL_TYPES).default("PETROL"),
    transmission: z.enum(TRANSMISSIONS).default("MANUAL"),
    mileageKm: z.number().int().min(0).default(0),
  }),
});

export const updateVehicleSchema = z.object({
  body: z
    .object({
      color: z.string().max(30).optional(),
      mileageKm: z.number().int().min(0).optional(),
    })
    .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" }),
  params: z.object({ vehicleId: z.string().uuid() }),
});

export const updateVehicleStatusSchema = z.object({
  body: z.object({
    status: z.enum(STATUSES),
  }),
  params: z.object({ vehicleId: z.string().uuid() }),
});

export const assignDriverSchema = z.object({
  body: z.object({
    driverId: z.string().uuid(),
    commissionPercent: z.number().min(0).max(100),
    ownerSharePercent: z.number().min(0).max(100),
  }),
  params: z.object({ vehicleId: z.string().uuid() }),
});

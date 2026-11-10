import { z } from "zod";

const vehicleId = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date");
const SERVICES = ["OIL_CHANGE", "BRAKE_REPAIR", "ENGINE_REPAIR", "TYRE_REPLACEMENT", "BATTERY_REPLACEMENT", "GENERAL_SERVICE", "ELECTRICAL_REPAIR", "AC_REPAIR", "BODY_WORK", "EMERGENCY_REPAIR"] as const;

export const vehicleParam = z.object({ params: z.object({ vehicleId }) });
export const addRecordSchema = z.object({
  params: z.object({ vehicleId }),
  body: z.object({
    serviceType: z.enum(SERVICES), cost: z.number().min(0).max(10_000_000).optional(), odometerKm: z.number().int().min(0).max(5_000_000).optional(),
    performedAt: z.coerce.date().optional(), notes: z.string().max(1000).optional(), nextDueAt: z.coerce.date().nullable().optional(),
  }).strict(),
});
export const addDocumentSchema = z.object({
  params: z.object({ vehicleId }),
  body: z.object({
    docType: z.enum(["INSURANCE", "REGISTRATION", "POLLUTION", "PERMIT", "FITNESS"]), documentNumber: z.string().max(60).optional(),
    issuedAt: day.optional(), expiresAt: day, notes: z.string().max(500).optional(),
  }).strict(),
});
export const deleteDocumentSchema = z.object({ params: z.object({ vehicleId, documentId: z.string().uuid() }) });
export const addIncidentSchema = z.object({
  params: z.object({ vehicleId }),
  body: z.object({ occurredAt: day, severity: z.enum(["MINOR", "MODERATE", "MAJOR"]), description: z.string().trim().min(3).max(1000), repairCost: z.number().min(0).max(10_000_000).optional() }).strict(),
});

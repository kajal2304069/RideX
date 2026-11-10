import { z } from "zod";

export const onboardDriverSchema = z.object({
  body: z.object({
    licenseNumber: z.string().min(4).max(50),
    // ISO date string, e.g. "2028-06-30" - validated as a real future date
    // in the service layer (business rule), not here (format rule).
    licenseExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "licenseExpiry must be YYYY-MM-DD"),
  }),
});

export const verifyDriverSchema = z.object({
  body: z.object({
    status: z.enum(["VERIFIED", "REJECTED"]),
    reason: z.string().max(500).optional(),
  }),
  params: z.object({
    driverId: z.string().uuid(),
  }),
});

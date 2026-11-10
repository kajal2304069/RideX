import { z } from "zod";

const uuid = z.string().uuid();
const date = z.coerce.date();
const limit = z.coerce.number().int().min(1).max(100).default(20);
const cursor = z.string().max(400).optional();
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const reason = z.string().trim().min(3, "A reason is required").max(500);
const ROLES = ["RIDER", "DRIVER", "VEHICLE_OWNER", "GARAGE_OWNER", "MECHANIC", "SELLER", "BUYER", "ADMIN"] as const;
const range = { from: date.optional(), to: date.optional() };
const orderedRange = (q: { from?: Date; to?: Date }) => !q.from || !q.to || q.from < q.to;
const rangeMsg = "`from` must be before `to`";

const listQuery = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ query: z.object({ limit, cursor, ...shape }).strict().refine(orderedRange as any, rangeMsg) });

export const listUsersSchema = listQuery({ q: z.string().trim().min(1).max(100).optional(), role: z.enum(ROLES).optional(), active: bool.optional() });
export const listDriversSchema = listQuery({
  verification: z.enum(["PENDING", "VERIFIED", "REJECTED"]).optional(), online: bool.optional(), q: z.string().trim().min(1).max(100).optional(),
});
export const listVehiclesSchema = listQuery({
  status: z.enum(["AVAILABLE", "RENTED", "IN_RIDE_SERVICE", "UNDER_MAINTENANCE", "UNAVAILABLE"]).optional(), ownerId: uuid.optional(), q: z.string().trim().min(1).max(100).optional(),
});
export const listRidesSchema = listQuery({
  status: z.enum(["REQUESTED", "SEARCHING_DRIVER", "DRIVER_ASSIGNED", "DRIVER_ARRIVING", "DRIVER_ARRIVED", "TRIP_STARTED", "TRIP_COMPLETED", "PAYMENT_COMPLETED", "CANCELLED_BY_RIDER", "CANCELLED_BY_DRIVER", "CANCELLED_BY_SYSTEM"]).optional(),
  riderId: uuid.optional(), driverId: uuid.optional(), ...range,
});
export const listRentalsSchema = listQuery({
  status: z.enum(["PENDING_PAYMENT", "CONFIRMED", "ACTIVE", "COMPLETED", "CANCELLED", "EXPIRED"]).optional(), renterId: uuid.optional(), ownerId: uuid.optional(), ...range,
});
export const listListingsSchema = listQuery({ status: z.enum(["ACTIVE", "SOLD", "DELISTED"]).optional(), sellerId: uuid.optional(), q: z.string().trim().min(1).max(100).optional() });
export const listGaragesSchema = listQuery({ active: bool.optional(), q: z.string().trim().min(1).max(100).optional() });
export const listPaymentsSchema = listQuery({
  status: z.enum(["PENDING", "PROCESSING", "SUCCESS", "FAILED", "REFUNDED"]).optional(), payableType: z.enum(["RIDE", "RENTAL", "MARKETPLACE", "GARAGE_SERVICE"]).optional(), payerId: uuid.optional(), ...range,
});
export const auditLogsSchema = listQuery({
  actorId: uuid.optional(), action: z.string().trim().min(1).max(100).optional(), entityType: z.string().trim().min(1).max(100).optional(), entityId: uuid.optional(), ...range,
});

export const userIdParam = z.object({ params: z.object({ userId: uuid }) });
export const reasonBody = z.object({ params: z.object({ userId: uuid }), body: z.object({ reason }).strict() });
export const changeRolesSchema = z.object({
  params: z.object({ userId: uuid }),
  body: z.object({ add: z.array(z.enum(ROLES)).max(8).default([]), remove: z.array(z.enum(ROLES)).max(8).default([]), reason })
    .strict().refine((b) => b.add.length + b.remove.length > 0, "Provide roles to add or remove"),
});
export const listingReasonSchema = z.object({ params: z.object({ listingId: uuid }), body: z.object({ reason }).strict() });
export const garageReasonSchema = z.object({ params: z.object({ garageId: uuid }), body: z.object({ reason }).strict() });

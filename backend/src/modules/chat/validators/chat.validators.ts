import { z } from "zod";

const rideId = z.string().uuid();
export const sendSchema = z.object({ params: z.object({ rideId }), body: z.object({ body: z.string().max(1000) }).strict() });
export const listSchema = z.object({
  params: z.object({ rideId }),
  query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(300).optional() }).strict(),
});

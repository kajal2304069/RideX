import { z } from "zod";

export const computeRouteSchema = z.object({
  body: z.object({
    from: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
    to: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  }),
});

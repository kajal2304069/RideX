import { z } from "zod";

export const listNotificationsSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    unreadOnly: z.enum(["true", "false"]).default("false"),
    before: z.coerce.date().optional(),
  }),
});

export const notificationIdParamSchema = z.object({
  params: z.object({ notificationId: z.string().uuid() }),
});

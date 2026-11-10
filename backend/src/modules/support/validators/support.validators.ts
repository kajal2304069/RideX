import { z } from "zod";

const id = z.string().uuid();
const PRIORITY = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const STATUS = z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]);
const page = { limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().max(300).optional() };

export const createTicketSchema = z.object({
  body: z.object({ subject: z.string().trim().min(3).max(200), description: z.string().trim().max(4000).optional(), priority: PRIORITY.default("MEDIUM") }).strict(),
});
export const listMineSchema = z.object({ query: z.object(page).strict() });
export const listAllSchema = z.object({ query: z.object({ ...page, status: STATUS.optional(), priority: PRIORITY.optional() }).strict() });
export const ticketIdSchema = z.object({ params: z.object({ ticketId: id }) });
export const replySchema = z.object({ params: z.object({ ticketId: id }), body: z.object({ body: z.string().max(4000) }).strict() });
export const updateTicketSchema = z.object({
  params: z.object({ ticketId: id }),
  body: z.object({ status: STATUS.optional(), priority: PRIORITY.optional(), assignToMe: z.boolean().optional() }).strict()
    .refine((b) => Object.keys(b).length > 0, "Nothing to update"),
});

import { z } from "zod";

const date = z.coerce.date();

const rangeQuery = z.object({ from: date.optional(), to: date.optional() }).strict()
  .refine((q) => !q.from || !q.to || q.from < q.to, "`from` must be before `to`");

export const summarySchema = z.object({ query: rangeQuery });

export const entriesSchema = z.object({
  query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().max(300).optional() }).strict(),
});

export const withdrawSchema = z.object({
  // `amount` is optional: omitted means "everything available". The balance is always computed server-side.
  body: z.object({ amount: z.number().positive().max(10_000_000).multipleOf(0.01).optional() }).strict(),
});

export const listPayoutsSchema = z.object({
  query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict(),
});

export const reconcileSchema = z.object({
  body: z.object({ limit: z.number().int().min(1).max(500).default(100) }).strict().default({}),
});

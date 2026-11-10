import { z } from "zod";

const date = z.coerce.date();
const range = { from: date.optional(), to: date.optional() };
const ordered = (q: { from?: Date; to?: Date }) => !q.from || !q.to || q.from < q.to;

export const overviewSchema = z.object({ query: z.object({ ...range }).strict().refine(ordered, "`from` must be before `to`") });
export const timeseriesSchema = z.object({
  query: z.object({
    metric: z.enum(["rides", "completed_rides", "signups", "gmv", "commission"]),
    bucket: z.enum(["hour", "day", "week"]).default("day"),
    ...range,
  }).strict().refine(ordered, "`from` must be before `to`"),
});
export const leaderboardSchema = z.object({
  query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(10), ...range }).strict().refine(ordered, "`from` must be before `to`"),
});

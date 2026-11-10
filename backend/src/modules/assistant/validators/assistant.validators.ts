import { z } from "zod";
import { LANG_CODES } from "../services/languages";

export const askSchema = z.object({
  body: z.object({
    question: z.string().trim().min(1, "Say or type a question").max(500),
    language: z.enum(LANG_CODES).default("en"),
    /** Which screen the person is on, so "what do I do here?" can be answered. Free text is not accepted. */
    page: z.enum(["ride", "rent", "buy", "sell", "repair", "drive", "earnings", "payments", "admin", "login", "help", "other"]).default("other"),
  }).strict(),
});

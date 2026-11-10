import { Router } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../../../config/env";
import { redisStore } from "../../../middleware/rateLimiter";
import { validate } from "../../../middleware/validate";
import { assistantController as c } from "../controllers/assistant.controller";
import { askSchema } from "../validators/assistant.validators";

/**
 * Public on purpose: people who have not signed up yet are the ones who most need help. Because it is public and each call
 * can cost money, it has its own tight per-IP limit on top of the global one.
 */
const limiter = rateLimit({
  windowMs: 60_000, limit: env.ASSISTANT_RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false,
  skip: () => env.NODE_ENV === "test", store: redisStore("rl:assistant:"),
  message: { success: false, error: { code: "RATE_LIMITED", message: "You are asking very fast. Please wait a moment." } },
});

export const assistantRouter = Router();
assistantRouter.get("/languages", c.languages);
assistantRouter.post("/ask", limiter, validate(askSchema), c.ask);

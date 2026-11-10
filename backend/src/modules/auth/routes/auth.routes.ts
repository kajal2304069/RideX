import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authController } from "../controllers/auth.controller";
import { validate } from "../../../middleware/validate";
import { authenticate } from "../../../middleware/auth";
import { registerSchema, loginSchema, refreshSchema } from "../validators/auth.validators";
import { env } from "../../../config/env";
import { redisStore } from "../../../middleware/rateLimiter";

export const authRouter = Router();

/**
 * Login/register get a much stricter limiter than the global one -
 * these are exactly the endpoints brute-force and credential-stuffing
 * attacks target. Backed by the same Redis store as the global limiter
 * (Phase 11) so the limit is enforced correctly across multiple backend
 * instances, not just within whichever process happens to handle a
 * given request. Skipped under NODE_ENV=test so the automated test
 * suite (which fires many rapid requests from one IP) doesn't throttle
 * itself.
 */
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.NODE_ENV === "test",
  store: redisStore("rl:credential:"),
  message: {
    success: false,
    error: { code: "RATE_LIMITED", message: "Too many attempts. Please try again later." },
  },
});

authRouter.post("/register", credentialLimiter, validate(registerSchema), authController.register);
authRouter.post("/login", credentialLimiter, validate(loginSchema), authController.login);
authRouter.post("/refresh", validate(refreshSchema), authController.refresh);
authRouter.post("/logout", authController.logout);
authRouter.get("/me", authenticate, authController.me);

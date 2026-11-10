import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { ApiError } from "../common/ApiError";
import { logger } from "../config/logger";

/**
 * Single funnel for every error in the app (thrown in controllers,
 * services, repositories, or forwarded via asyncHandler's next(err)).
 *
 * Never leaks stack traces or internal details to the client in
 * production. Operational errors (ApiError) get their intended status
 * code; anything unexpected becomes a generic 500 so we never expose
 * DB errors, secrets, etc.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
) {
  if (err instanceof ZodError) {
    logger.warn({ requestId: req.requestId, issues: err.issues }, "Validation error");
    return res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: err.flatten(),
      },
      requestId: req.requestId,
    });
  }

  if (err instanceof ApiError) {
    const level = err.statusCode >= 500 ? "error" : "warn";
    logger[level](
      { requestId: req.requestId, code: err.code, err },
      err.message
    );
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
      requestId: req.requestId,
    });
  }

  // Unexpected/unknown error - log full detail server-side, hide it from the client.
  logger.error({ requestId: req.requestId, err }, "Unhandled error");
  return res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong. Please try again.",
    },
    requestId: req.requestId,
  });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    success: false,
    error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.originalUrl} not found` },
    requestId: req.requestId,
  });
}

/**
 * Every intentional, expected failure in the app should throw an ApiError
 * (not a raw Error). This lets the central error handler middleware turn
 * it into a consistent JSON shape and the correct HTTP status code,
 * instead of every controller reinventing error responses.
 */
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly isOperational: boolean;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, "BAD_REQUEST", message, details);
  }
  static unauthorized(message = "Unauthorized") {
    return new ApiError(401, "UNAUTHORIZED", message);
  }
  static forbidden(message = "Forbidden") {
    return new ApiError(403, "FORBIDDEN", message);
  }
  static notFound(message = "Resource not found") {
    return new ApiError(404, "NOT_FOUND", message);
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError(409, "CONFLICT", message, details);
  }
  static tooManyRequests(message = "Too many requests") {
    return new ApiError(429, "RATE_LIMITED", message);
  }
  static internal(message = "Internal server error", details?: unknown) {
    return new ApiError(500, "INTERNAL_ERROR", message, details);
  }
}

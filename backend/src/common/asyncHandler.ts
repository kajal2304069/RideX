import { NextFunction, Request, Response } from "express";

type AsyncFn = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Wraps async controller functions so thrown errors / rejected promises
 * are forwarded to Express's error-handling middleware automatically.
 * Keeps controllers "thin" - no repeated try/catch in every handler.
 */
export const asyncHandler = (fn: AsyncFn) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

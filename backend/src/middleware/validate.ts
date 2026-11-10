import { NextFunction, Request, Response } from "express";
import { AnyZodObject } from "zod";

/**
 * Wraps a zod schema shaped like { body?, params?, query? } and validates
 * the matching parts of the request. Thrown ZodErrors are caught by
 * asyncHandler/errorHandler and turned into a 400 with field-level detail -
 * controllers never see invalid input.
 */
export const validate =
  (schema: AnyZodObject) => (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.parse({
      body: req.body,
      params: req.params,
      query: req.query,
    });
    if (parsed.body) req.body = parsed.body;
    if (parsed.query) req.query = parsed.query;
    next();
  };

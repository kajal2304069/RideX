import { NextFunction, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

/**
 * Attaches a unique request ID to every request (accepts an inbound
 * X-Request-Id from an upstream proxy/load balancer if present, so a
 * single request can be traced end-to-end across services later).
 * Every log line for this request should include it.
 */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header("x-request-id");
  req.requestId = incoming || uuidv4();
  res.setHeader("x-request-id", req.requestId);
  next();
}

import { NextFunction, Request, Response } from "express";
import { ApiError } from "../common/ApiError";
import { verifyAccessToken } from "../common/jwt";
import { isTokenRevoked } from "../common/tokenRevocation";
import { UserRole } from "../modules/auth/types/auth.types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { sub: string; roles: UserRole[] };
    }
  }
}

/**
 * Verifies the Bearer access token and attaches `req.user`. The signature check is stateless (no database), so a
 * request costs no query. One cheap Redis lookup (see common/tokenRevocation.ts) lets an admin's deactivation or role
 * change take effect immediately instead of when the token expires (~15 min).
 */
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return next(ApiError.unauthorized("Missing or malformed Authorization header"));
  }

  let payload;
  try {
    payload = verifyAccessToken(header.slice("Bearer ".length));
  } catch {
    return next(ApiError.unauthorized("Invalid or expired access token"));
  }

  isTokenRevoked(payload.sub, payload.iat).then(
    (revoked) => {
      if (revoked) return next(ApiError.unauthorized("Session is no longer valid; please sign in again"));
      req.user = { sub: payload.sub, roles: payload.roles as UserRole[] };
      next();
    },
    (err) => next(err)
  );
}

/**
 * For endpoints that are public but behave differently for a logged-in
 * viewer (e.g. a garage owner sees their own inactive garage). No header
 * means anonymous. A header that is PRESENT but invalid is rejected with
 * 401 rather than quietly downgraded to anonymous, so an expired token
 * surfaces as an error the client can react to (refresh) instead of
 * mysteriously missing data.
 */
export function optionalAuthenticate(req: Request, res: Response, next: NextFunction) {
  if (!req.header("authorization")) return next();
  return authenticate(req, res, next);
}

/**
 * RBAC gate: use AFTER `authenticate`. A user needs at least ONE of the
 * listed roles (spec section 5: users can hold multiple roles at once,
 * e.g. Rider + Vehicle Owner - this is a union check, not "must have all").
 */
export function authorize(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(ApiError.unauthorized());
    const hasRole = req.user.roles.some((r) => allowedRoles.includes(r));
    if (!hasRole) return next(ApiError.forbidden("You don't have permission to perform this action"));
    next();
  };
}

import jwt, { JwtPayload } from "jsonwebtoken";
import { env } from "../config/env";

/**
 * Access and refresh tokens use DIFFERENT secrets on purpose: if an
 * access-token secret is ever leaked (e.g. via a misconfigured log or a
 * client-side bug), an attacker still cannot mint refresh tokens (and
 * vice versa). Access tokens are short-lived and stateless (never
 * checked against the DB); refresh tokens are long-lived and always
 * checked against the `refresh_tokens` table (see auth.repository.ts)
 * so they can be individually revoked.
 */

export interface AccessTokenPayload extends JwtPayload {
  sub: string; // user id
  roles: string[];
  type: "access";
}

export interface RefreshTokenPayload extends JwtPayload {
  sub: string; // user id
  jti: string; // refresh_tokens.id - links the JWT to its DB row
  type: "refresh";
}

export function signAccessToken(userId: string, roles: string[]): string {
  const payload: Omit<AccessTokenPayload, "iat" | "exp"> = { sub: userId, roles, type: "access" };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function signRefreshToken(userId: string, tokenId: string): string {
  const payload: Omit<RefreshTokenPayload, "iat" | "exp"> = { sub: userId, jti: tokenId, type: "refresh" };
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
  if (decoded.type !== "access") throw new Error("Not an access token");
  return decoded;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
  if (decoded.type !== "refresh") throw new Error("Not a refresh token");
  return decoded;
}

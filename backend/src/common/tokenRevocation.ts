import { redis } from "../config/redis";
import { logger } from "../config/logger";

/**
 * Access tokens are stateless JWTs, so by themselves they stay valid until they expire (15 min). That is fine for
 * routine use but not when an ADMIN deactivates an account or changes someone's roles: that must take effect NOW.
 *
 * Two tiny Redis keys give instant revocation without a database hit per request:
 *   auth:deactivated:<userId>      - the account is disabled: reject every token
 *   auth:valid-after:<userId>      - epoch seconds: reject tokens issued BEFORE this moment (e.g. after a role change;
 *                                    the client refreshes and gets a token carrying the new roles)
 * Both expire after the longest an access token can live, because after that no old token exists to reject. Durable
 * state (is_active, roles) lives in PostgreSQL; refresh and login read it from there.
 *
 * FAIL OPEN: if Redis is unreachable we log and let the request through. The alternative (reject everyone) would turn
 * a cache outage into a full outage; the exposure is bounded by the token's 15-minute life. See docs.
 */
const TTL_SECONDS = 60 * 60;
const deactivatedKey = (id: string) => `auth:deactivated:${id}`;
const validAfterKey = (id: string) => `auth:valid-after:${id}`;

export async function markDeactivated(userId: string): Promise<void> {
  await redis.set(deactivatedKey(userId), "1", "EX", TTL_SECONDS);
}

export async function clearDeactivated(userId: string): Promise<void> {
  await redis.del(deactivatedKey(userId));
}

/**
 * Invalidates access tokens issued BEFORE the current second. JWT `iat` has one-second resolution, so a token issued in
 * the same second as the change is indistinguishable and survives (<= 1 s window). The alternative (rejecting
 * same-second tokens) would also reject the fresh token the user gets by logging in right after the change.
 * Deactivation has no such window: it uses the absolute `auth:deactivated` flag.
 */
export async function invalidateTokensIssuedBefore(userId: string, at = new Date()): Promise<void> {
  await redis.set(validAfterKey(userId), String(Math.floor(at.getTime() / 1000)), "EX", TTL_SECONDS);
}

/** True when the token must be refused. `iat` is the token's issued-at claim in epoch seconds. */
export async function isTokenRevoked(userId: string, iat: number | undefined): Promise<boolean> {
  try {
    const [deactivated, validAfter] = await redis.mget(deactivatedKey(userId), validAfterKey(userId));
    if (deactivated) return true;
    if (validAfter && (iat === undefined || iat < Number(validAfter))) return true;
    return false;
  } catch (err) {
    logger.warn({ err, userId }, "Token revocation check unavailable; failing open");
    return false;
  }
}

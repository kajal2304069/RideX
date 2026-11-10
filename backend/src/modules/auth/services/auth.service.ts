import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { ApiError } from "../../../common/ApiError";
import { hashPassword, verifyPassword } from "../../../common/password";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../../common/jwt";
import { env } from "../../../config/env";
import { logger } from "../../../config/logger";
import { authRepository } from "../repositories/auth.repository";
import { AuthTokens, PublicUser, toPublicUser, UserRole } from "../types/auth.types";

function hashToken(token: string): string {
  // Refresh tokens are high-value bearer credentials; store only a
  // one-way hash so a DB read alone can't be replayed as a session.
  return crypto.createHash("sha256").update(token).digest("hex");
}

function refreshExpiryDate(): Date {
  const match = /^(\d+)([smhd])$/.exec(env.JWT_REFRESH_EXPIRES_IN);
  const amount = match ? Number(match[1]) : 7;
  const unit = match ? match[2] : "d";
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 86_400_000;
  return new Date(Date.now() + amount * unitMs);
}

async function issueTokenPair(
  userId: string,
  roles: UserRole[],
  meta?: { userAgent?: string; ip?: string }
): Promise<AuthTokens> {
  const tokenId = uuidv4();
  const refreshToken = signRefreshToken(userId, tokenId);
  await authRepository.storeRefreshToken({
    userId,
    tokenId,
    tokenHash: hashToken(refreshToken),
    expiresAt: refreshExpiryDate(),
    userAgent: meta?.userAgent,
    ip: meta?.ip,
  });
  return { accessToken: signAccessToken(userId, roles), refreshToken };
}

export const authService = {
  async register(input: {
    email: string;
    password: string;
    fullName: string;
    phone?: string;
    roles: string[];
  }): Promise<{ user: PublicUser; tokens: AuthTokens }> {
    const existing = await authRepository.findByEmail(input.email);
    if (existing) {
      // Deliberately generic message - don't confirm/deny which emails
      // are registered (avoids account enumeration).
      throw ApiError.conflict("Unable to register with the provided details");
    }

    const passwordHash = await hashPassword(input.password);
    const user = await authRepository.createUser({
      email: input.email,
      passwordHash,
      fullName: input.fullName,
      phone: input.phone,
      roles: input.roles,
    });

    const tokens = await issueTokenPair(user.id, user.roles);
    logger.info({ userId: user.id }, "User registered");
    return { user: toPublicUser(user), tokens };
  },

  async login(
    email: string,
    password: string,
    meta?: { userAgent?: string; ip?: string }
  ): Promise<{ user: PublicUser; tokens: AuthTokens }> {
    const user = await authRepository.findByEmail(email);

    // Same error for "no such user" and "wrong password" - prevents
    // account enumeration via response differences.
    const invalidCredentials = () => ApiError.unauthorized("Invalid email or password");

    if (!user) throw invalidCredentials();
    if (!user.is_active) throw ApiError.forbidden("This account has been deactivated");

    const valid = await verifyPassword(user.password_hash, password);
    if (!valid) throw invalidCredentials();

    const tokens = await issueTokenPair(user.id, user.roles, meta);
    logger.info({ userId: user.id }, "User logged in");
    return { user: toPublicUser(user), tokens };
  },

  async refresh(
    rawRefreshToken: string,
    meta?: { userAgent?: string; ip?: string }
  ): Promise<AuthTokens> {
    let payload;
    try {
      payload = verifyRefreshToken(rawRefreshToken);
    } catch {
      throw ApiError.unauthorized("Invalid or expired refresh token");
    }

    const stored = await authRepository.findRefreshTokenById(payload.jti);
    if (!stored || stored.token_hash !== hashToken(rawRefreshToken)) {
      throw ApiError.unauthorized("Invalid or expired refresh token");
    }

    if (stored.revoked_at) {
      // REUSE DETECTED: this exact refresh token was already rotated away
      // once before. Someone is replaying an old token - possibly a
      // stolen one. Treat this as a compromise signal and kill every
      // active session for the user, forcing a fresh login everywhere.
      logger.warn({ userId: stored.user_id, tokenId: stored.id }, "Refresh token reuse detected - revoking all sessions");
      await authRepository.revokeAllForUser(stored.user_id);
      throw ApiError.unauthorized("Session invalidated - please log in again");
    }

    if (stored.expires_at < new Date()) {
      throw ApiError.unauthorized("Invalid or expired refresh token");
    }

    const user = await authRepository.findById(stored.user_id);
    if (!user || !user.is_active) throw ApiError.unauthorized("Invalid or expired refresh token");

    const newTokenId = uuidv4();
    const newRefreshToken = signRefreshToken(user.id, newTokenId);

    await authRepository.rotateRefreshToken(stored.id, {
      tokenId: newTokenId,
      userId: user.id,
      tokenHash: hashToken(newRefreshToken),
      expiresAt: refreshExpiryDate(),
      userAgent: meta?.userAgent,
      ip: meta?.ip,
    });

    return { accessToken: signAccessToken(user.id, user.roles), refreshToken: newRefreshToken };
  },

  async logout(rawRefreshToken: string): Promise<void> {
    try {
      const payload = verifyRefreshToken(rawRefreshToken);
      await authRepository.revokeRefreshToken(payload.jti);
    } catch {
      // Logging out with an already-invalid token is a no-op, not an error -
      // the end state (no valid session) is what the caller wanted anyway.
    }
  },

  async getPublicUser(userId: string): Promise<PublicUser> {
    const user = await authRepository.findById(userId);
    if (!user) throw ApiError.notFound("User not found");
    return toPublicUser(user);
  },
};

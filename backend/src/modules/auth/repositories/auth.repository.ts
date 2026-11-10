import { PoolClient } from "pg";
import { pool, withTransaction } from "../../../db/pool";
import { UserRecord } from "../types/auth.types";
import { parsePgEnumArray } from "../../../utils/pgArray";

function normalizeUser<T extends UserRecord | undefined | null>(user: T): T {
  if (!user) return user;
  return { ...user, roles: parsePgEnumArray(user.roles) as UserRecord["roles"] };
}

export const authRepository = {
  async findByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await pool.query<UserRecord>(
      `SELECT * FROM users WHERE email = $1`,
      [email]
    );
    return normalizeUser(rows[0]) ?? null;
  },

  async findById(id: string): Promise<UserRecord | null> {
    const { rows } = await pool.query<UserRecord>(`SELECT * FROM users WHERE id = $1`, [id]);
    return normalizeUser(rows[0]) ?? null;
  },

  /**
   * Creates the user row and, if RIDER is among the signup roles,
   * atomically provisions the corresponding `riders` profile row in the
   * same transaction - a rider needs no extra onboarding info (unlike
   * DRIVER, which requires a license number/expiry collected via a
   * separate onboarding step - see modules/drivers), so there's no
   * reason to make it a second request the client has to remember to
   * make. If this insert fails partway, the whole thing rolls back:
   * we never want a user row with roles=['RIDER'] but no riders row.
   */
  async createUser(input: {
    email: string;
    passwordHash: string;
    fullName: string;
    phone?: string;
    roles: string[];
  }): Promise<UserRecord> {
    return withTransaction(async (client) => {
      const { rows } = await client.query<UserRecord>(
        `INSERT INTO users (email, password_hash, full_name, phone, roles)
         VALUES ($1, $2, $3, $4, $5::user_role[])
         RETURNING *`,
        [input.email, input.passwordHash, input.fullName, input.phone ?? null, input.roles]
      );
      const user = normalizeUser(rows[0]);

      if (input.roles.includes("RIDER")) {
        await client.query(`INSERT INTO riders (user_id) VALUES ($1)`, [user.id]);
      }

      return user;
    });
  },

  /**
   * Stores a new refresh token row. `tokenHash` is a SHA-256 hash of the
   * raw JWT (never the raw token) - see auth.service.ts.
   */
  async storeRefreshToken(
    input: { userId: string; tokenId: string; tokenHash: string; expiresAt: Date; userAgent?: string; ip?: string },
    client?: PoolClient
  ): Promise<void> {
    const runner = client ?? pool;
    await runner.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.tokenId, input.userId, input.tokenHash, input.expiresAt, input.userAgent ?? null, input.ip ?? null]
    );
  },

  async findRefreshTokenById(tokenId: string) {
    const { rows } = await pool.query(
      `SELECT * FROM refresh_tokens WHERE id = $1`,
      [tokenId]
    );
    return rows[0] ?? null;
  },

  /**
   * Rotation: mark the old token revoked + point it at its replacement,
   * insert the new token, in a single transaction so a crash mid-way
   * can never leave two simultaneously-valid tokens (or a revoked token
   * with no replacement).
   */
  async rotateRefreshToken(
    oldTokenId: string,
    newToken: { tokenId: string; userId: string; tokenHash: string; expiresAt: Date; userAgent?: string; ip?: string }
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $1 WHERE id = $2`,
        [newToken.tokenId, oldTokenId]
      );
      await this.storeRefreshToken(newToken, client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },

  async revokeRefreshToken(tokenId: string): Promise<void> {
    await pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [tokenId]);
  },

  async revokeAllForUser(userId: string): Promise<void> {
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
  },
};

import { pool } from "../../../db/pool";
import { NotificationRecord } from "../types/notifications.types";

const COLUMNS = `id, user_id, type, title, body, data, read_at, created_at, dedupe_key, email_sent_at`;

export const notificationsRepository = {
  /**
   * Idempotent insert. `inserted: false` means a row for this
   * (user, dedupe_key) already exists - a retry or duplicate - and the
   * existing row is returned instead.
   */
  async insertIfAbsent(input: {
    userId: string;
    type: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    dedupeKey: string;
  }): Promise<{ row: NotificationRecord; inserted: boolean }> {
    const ins = await pool.query<NotificationRecord>(
      `INSERT INTO notifications (user_id, type, title, body, data, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [input.userId, input.type, input.title, input.body, JSON.stringify(input.data), input.dedupeKey]
    );
    if (ins.rows[0]) return { row: ins.rows[0], inserted: true };

    const existing = await pool.query<NotificationRecord>(
      `SELECT ${COLUMNS} FROM notifications WHERE user_id = $1 AND dedupe_key = $2`,
      [input.userId, input.dedupeKey]
    );
    return { row: existing.rows[0], inserted: false };
  },

  async markEmailSent(id: string): Promise<void> {
    await pool.query(`UPDATE notifications SET email_sent_at = now() WHERE id = $1 AND email_sent_at IS NULL`, [id]);
  },

  async findUserContact(userId: string): Promise<{ email: string; full_name: string } | null> {
    const { rows } = await pool.query<{ email: string; full_name: string }>(`SELECT email, full_name FROM users WHERE id = $1`, [userId]);
    return rows[0] ?? null;
  },

  async list(userId: string, opts: { limit: number; unreadOnly: boolean; before?: Date }): Promise<NotificationRecord[]> {
    const { rows } = await pool.query<NotificationRecord>(
      `SELECT ${COLUMNS} FROM notifications
       WHERE user_id = $1
         AND ($2::boolean = false OR read_at IS NULL)
         AND ($3::timestamptz IS NULL OR created_at < $3)
       ORDER BY created_at DESC, id DESC
       LIMIT $4`,
      [userId, opts.unreadOnly, opts.before ?? null, opts.limit]
    );
    return rows;
  },

  async countUnread(userId: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [userId]);
    return rows[0].n;
  },

  /** Scoped to the owner in the WHERE clause, so you cannot mark someone else's notification read. */
  async markRead(id: string, userId: string): Promise<NotificationRecord | null> {
    const { rows } = await pool.query<NotificationRecord>(
      `UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
      [id, userId]
    );
    return rows[0] ?? null;
  },

  async markAllRead(userId: string): Promise<number> {
    const { rowCount } = await pool.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [userId]);
    return rowCount ?? 0;
  },
};

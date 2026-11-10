import { pool, withTransaction } from "../../../db/pool";
import { keysetPage, Where } from "../../admin/repositories/pagination";

const COLS = `a.id, a.user_id, a.subject, a.description, a.status::text AS status, a.priority::text AS priority, a.assigned_to, a.resolved_at, a.created_at, a.updated_at`;

export const supportRepository = {
  async findById(id: string) {
    const { rows } = await pool.query(`SELECT ${COLS} FROM support_tickets a WHERE a.id = $1`, [id]);
    return rows[0] ?? null;
  },

  /** Counts + inserts under a lock on the user's row so two simultaneous submissions cannot both slip under the cap. */
  async createLimited(userId: string, input: { subject: string; description?: string; priority: string }, maxActive: number) {
    return withTransaction(async (client) => {
      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      const n = await client.query(`SELECT COUNT(*)::int AS n FROM support_tickets WHERE user_id = $1 AND status IN ('OPEN','IN_PROGRESS')`, [userId]);
      if (n.rows[0].n >= maxActive) return null;
      const { rows } = await client.query(
        `INSERT INTO support_tickets (user_id, subject, description, priority) VALUES ($1, $2, $3, $4::support_ticket_priority) RETURNING id`,
        [userId, input.subject, input.description ?? null, input.priority]
      );
      return rows[0].id as string;
    });
  },

  listMine(userId: string, limit: number, cursor?: string) {
    const w = new Where().add((p) => `a.user_id = ${p(userId)}`);
    return keysetPage(COLS, "FROM support_tickets a", w, limit, cursor);
  },

  listAll(f: { status?: string; priority?: string }, limit: number, cursor?: string) {
    const w = new Where();
    if (f.status) w.add((p) => `a.status = ${p(f.status)}::support_ticket_status`);
    if (f.priority) w.add((p) => `a.priority = ${p(f.priority)}::support_ticket_priority`);
    return keysetPage(`${COLS}, (SELECT email FROM users u WHERE u.id = a.user_id) AS user_email`, "FROM support_tickets a", w, limit, cursor);
  },

  async messages(ticketId: string) {
    const { rows } = await pool.query(
      `SELECT id, author_id, is_staff, body, created_at FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at, id`, [ticketId]
    );
    return rows;
  },

  /** Adds a reply unless the ticket is CLOSED, atomically (the status is re-checked under the row lock). */
  async addMessage(ticketId: string, authorId: string, isStaff: boolean, body: string, reopen: boolean) {
    return withTransaction(async (client) => {
      const t = await client.query(`SELECT status::text AS status FROM support_tickets WHERE id = $1 FOR UPDATE`, [ticketId]);
      if (!t.rows[0]) return { outcome: "missing" as const };
      if (t.rows[0].status === "CLOSED") return { outcome: "closed" as const };
      const { rows } = await client.query(
        `INSERT INTO support_ticket_messages (ticket_id, author_id, is_staff, body) VALUES ($1, $2, $3, $4) RETURNING id, author_id, is_staff, body, created_at`,
        [ticketId, authorId, isStaff, body]
      );
      // A customer replying to a RESOLVED ticket reopens it; any reply bumps updated_at.
      await client.query(
        `UPDATE support_tickets SET updated_at = now(),
           status = CASE WHEN $2 AND status = 'RESOLVED' THEN 'OPEN'::support_ticket_status ELSE status END,
           resolved_at = CASE WHEN $2 AND status = 'RESOLVED' THEN NULL ELSE resolved_at END
         WHERE id = $1`,
        [ticketId, reopen]
      );
      return { outcome: "added" as const, message: rows[0] };
    });
  },

  /** Guarded status change: only moves a ticket that is still in `from`. */
  async transition(id: string, from: string, to: string, priority: string | undefined, assignedTo: string | undefined) {
    const { rowCount } = await pool.query(
      `UPDATE support_tickets SET status = $3::support_ticket_status,
              priority = COALESCE($4::support_ticket_priority, priority),
              assigned_to = COALESCE($5::uuid, assigned_to),
              resolved_at = CASE WHEN $3 IN ('RESOLVED','CLOSED') THEN COALESCE(resolved_at, now()) ELSE NULL END,
              updated_at = now()
       WHERE id = $1 AND status = $2::support_ticket_status`,
      [id, from, to, priority ?? null, assignedTo ?? null]
    );
    return (rowCount ?? 0) > 0;
  },

  async setPriority(id: string, priority: string) {
    await pool.query(`UPDATE support_tickets SET priority = $2::support_ticket_priority, updated_at = now() WHERE id = $1`, [id, priority]);
  },
};

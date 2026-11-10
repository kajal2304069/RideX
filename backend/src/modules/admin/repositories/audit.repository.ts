import { PoolClient } from "pg";
import { pool } from "../../../db/pool";
import { Page, Where, keysetPage } from "./pagination";

export interface AuditEntryInput {
  actorId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

export const auditRepository = {
  /** Pass the transaction's client to make the audit row commit or roll back WITH the change it describes. */
  async insert(e: AuditEntryInput, client?: PoolClient): Promise<void> {
    await (client ?? pool).query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata, ip_address) VALUES ($1, $2, $3, $4, $5, $6)`,
      [e.actorId, e.action, e.entityType ?? null, e.entityId ?? null, e.metadata ? JSON.stringify(e.metadata) : null, e.ip ?? null]
    );
  },

  async list(f: { actorId?: string; action?: string; entityType?: string; entityId?: string; from?: Date; to?: Date; limit: number; cursor?: string }): Promise<Page<unknown>> {
    const w = new Where();
    if (f.actorId) w.add((p) => `a.actor_id = ${p(f.actorId)}`);
    if (f.action) w.add((p) => `a.action = ${p(f.action)}`);
    if (f.entityType) w.add((p) => `a.entity_type = ${p(f.entityType)}`);
    if (f.entityId) w.add((p) => `a.entity_id = ${p(f.entityId)}`);
    if (f.from) w.add((p) => `a.created_at >= ${p(f.from)}`);
    if (f.to) w.add((p) => `a.created_at < ${p(f.to)}`);
    return keysetPage(
      `a.id, a.actor_id, u.email AS actor_email, a.action, a.entity_type, a.entity_id, a.metadata, a.ip_address, a.created_at`,
      `FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id`, w, f.limit, f.cursor,
      (r) => ({ id: r.id, actorId: r.actor_id, actorEmail: r.actor_email, action: r.action, entityType: r.entity_type, entityId: r.entity_id, metadata: r.metadata, ip: r.ip_address, createdAt: r.created_at })
    );
  },
};

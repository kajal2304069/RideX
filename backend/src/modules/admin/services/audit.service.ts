import { PoolClient } from "pg";
import { logger } from "../../../config/logger";
import { AuditEntryInput, auditRepository } from "../repositories/audit.repository";

export const auditService = {
  /** Inside a transaction: the audit row is part of the change. If it cannot be written, the change does not happen. */
  record: (e: AuditEntryInput, client: PoolClient) => auditRepository.insert(e, client),

  /**
   * For actions that already committed in another module (refund, driver verification). The money or status has moved,
   * so a failure to log must not turn a success into an error; it is logged loudly instead.
   */
  async recordAfter(e: AuditEntryInput): Promise<void> {
    try { await auditRepository.insert(e); } catch (err) { logger.error({ err, audit: e }, "FAILED TO WRITE AUDIT LOG"); }
  },
};

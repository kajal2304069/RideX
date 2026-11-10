import { pool } from "../../../db/pool";
import { PayableType, PaymentProviderName, PaymentRecord, PaymentStatus } from "../types/payments.types";

const COLUMNS = `id, payable_type, payable_id, payer_id, amount, currency, provider, provider_reference,
  status, idempotency_key, failure_reason, created_at, updated_at`;

export const paymentsRepository = {
  async findById(id: string): Promise<PaymentRecord | null> {
    const { rows } = await pool.query<PaymentRecord>(`SELECT ${COLUMNS} FROM payments WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },

  async findByIdempotencyKey(key: string): Promise<PaymentRecord | null> {
    const { rows } = await pool.query<PaymentRecord>(`SELECT ${COLUMNS} FROM payments WHERE idempotency_key = $1`, [key]);
    return rows[0] ?? null;
  },

  /** The payable's live payment (PENDING/PROCESSING/SUCCESS), if any. The partial unique index guarantees at most one. */
  async findLiveByPayable(type: PayableType, id: string): Promise<PaymentRecord | null> {
    const { rows } = await pool.query<PaymentRecord>(
      `SELECT ${COLUMNS} FROM payments
       WHERE payable_type = $1 AND payable_id = $2 AND status IN ('PENDING','PROCESSING','SUCCESS')`,
      [type, id]
    );
    return rows[0] ?? null;
  },

  async findByPayer(payerId: string, limit = 20): Promise<PaymentRecord[]> {
    const { rows } = await pool.query<PaymentRecord>(
      `SELECT ${COLUMNS} FROM payments WHERE payer_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [payerId, limit]
    );
    return rows;
  },

  /** Throws a 23505 unique_violation if the idempotency key or the live-payment-per-payable index is hit. */
  async createPending(input: {
    payableType: PayableType;
    payableId: string;
    payerId: string;
    amount: number;
    currency: string;
    provider: PaymentProviderName;
    idempotencyKey: string;
  }): Promise<PaymentRecord> {
    const { rows } = await pool.query<PaymentRecord>(
      `INSERT INTO payments (payable_type, payable_id, payer_id, amount, currency, provider, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7)
       RETURNING ${COLUMNS}`,
      [input.payableType, input.payableId, input.payerId, input.amount, input.currency, input.provider, input.idempotencyKey]
    );
    return rows[0];
  },

  /**
   * Optimistic transition: only moves the row if it is currently in one of
   * `from`. Returns null when someone else already moved it, so a stale
   * writer can never overwrite a newer state (e.g. SUCCESS -> FAILED).
   */
  async transition(
    id: string,
    from: PaymentStatus[],
    to: PaymentStatus,
    extra: { providerReference?: string; failureReason?: string } = {}
  ): Promise<PaymentRecord | null> {
    const { rows } = await pool.query<PaymentRecord>(
      `UPDATE payments
       SET status = $2::payment_status,
           provider_reference = COALESCE($3, provider_reference),
           failure_reason = COALESCE($4, failure_reason),
           updated_at = now()
       WHERE id = $1 AND status = ANY($5::payment_status[])
       RETURNING ${COLUMNS}`,
      [id, to, extra.providerReference ?? null, extra.failureReason ?? null, from]
    );
    return rows[0] ?? null;
  },
};

/**
 * Phase 12: DB-level guarantee against double payment.
 *
 * At most ONE "live" payment (PENDING / PROCESSING / SUCCESS) may exist per
 * payable (e.g. one ride). FAILED and REFUNDED rows are excluded so a declined
 * card can be retried and a refunded payable can be paid again.
 *
 * The app also takes a Redis lock and checks idempotency keys, but those are
 * fast paths. This index is the guarantee.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX payments_one_live_per_payable
    ON payments (payable_type, payable_id)
    WHERE status IN ('PENDING', 'PROCESSING', 'SUCCESS')
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS payments_one_live_per_payable`);
};

/**
 * Pure rules for WHEN a reminder fires. Each (item, stage) pair is notified at most once, because the stage is part of
 * the notification's dedupe key; so a daily scan can run any number of times without spamming anyone.
 */
export type ServiceStage = "OVERDUE" | "DUE_1D" | "DUE_7D";
export type DocumentStage = "EXPIRED" | "EXPIRES_1D" | "EXPIRES_7D" | "EXPIRES_30D";

export const SERVICE_HORIZON_DAYS = 7;
export const DOCUMENT_HORIZON_DAYS = 30;
/** After this many days past expiry we stop reminding: the owner knows. */
export const DOCUMENT_GRACE_AFTER_EXPIRY_DAYS = 30;

const DAY = 86_400_000;

/** Service dues carry a timestamp, so compare instants. */
export function serviceStage(nextDueAt: Date, now = new Date()): ServiceStage | null {
  const ms = nextDueAt.getTime() - now.getTime();
  if (ms < 0) return "OVERDUE";
  if (ms <= DAY) return "DUE_1D";
  if (ms <= SERVICE_HORIZON_DAYS * DAY) return "DUE_7D";
  return null;
}

/** The most urgent stage that applies. Documents are DATES, so compare calendar days in UTC. */
export function documentStage(expiresOn: string | Date, now = new Date()): DocumentStage | null {
  const exp = typeof expiresOn === "string" ? Date.parse(`${expiresOn.slice(0, 10)}T00:00:00Z`) : Date.UTC(expiresOn.getUTCFullYear(), expiresOn.getUTCMonth(), expiresOn.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((exp - today) / DAY);
  if (days < 0) return days >= -DOCUMENT_GRACE_AFTER_EXPIRY_DAYS ? "EXPIRED" : null;
  if (days <= 1) return "EXPIRES_1D";
  if (days <= 7) return "EXPIRES_7D";
  if (days <= DOCUMENT_HORIZON_DAYS) return "EXPIRES_30D";
  return null;
}

export const isoDay = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));

import { PartUsed } from "../types/repairs.types";

const toCents = (n: number) => Math.round(n * 100);

/**
 * Money is summed in integer cents, then converted back, so 0.1 + 0.2 style
 * floating-point drift can never leak into what a customer is charged.
 * Totals are ALWAYS computed here; the client never supplies parts_cost or
 * total_cost.
 */
export function computeRepairCosts(laborCost: number, parts: PartUsed[]): { laborCost: number; partsCost: number; totalCost: number } {
  const laborCents = toCents(laborCost);
  const partsCents = parts.reduce((sum, p) => sum + p.quantity * toCents(p.unitPrice), 0);
  return { laborCost: laborCents / 100, partsCost: partsCents / 100, totalCost: (laborCents + partsCents) / 100 };
}

/** How long after a service the next one is due, for the maintenance history (and, later, reminders). Null = no schedule. */
export const NEXT_DUE_DAYS: Record<string, number | null> = {
  OIL_CHANGE: 180,
  GENERAL_SERVICE: 180,
  BRAKE_REPAIR: 365,
  TYRE_REPLACEMENT: 730,
  BATTERY_REPLACEMENT: 730,
  ENGINE_REPAIR: null,
  ELECTRICAL_REPAIR: null,
  AC_REPAIR: null,
  BODY_WORK: null,
  EMERGENCY_REPAIR: null,
};

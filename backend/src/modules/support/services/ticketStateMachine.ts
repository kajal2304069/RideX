export type TicketStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";

/**
 * OPEN -> IN_PROGRESS -> RESOLVED -> CLOSED. A RESOLVED ticket can be reopened (the customer says it is not fixed);
 * CLOSED is final. Staff can close from anywhere (spam, duplicates).
 */
const NEXT: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["OPEN", "RESOLVED", "CLOSED"],
  RESOLVED: ["OPEN", "CLOSED"],
  CLOSED: [],
};

export const canTransition = (from: TicketStatus, to: TicketStatus) => NEXT[from].includes(to);
export const isOpenForReplies = (s: TicketStatus) => s !== "CLOSED";
export const MAX_ACTIVE_TICKETS_PER_USER = 10;

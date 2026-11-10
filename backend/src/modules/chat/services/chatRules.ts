import type { ChatRide } from "../repositories/chat.repository";

/** Chat is open while the ride is active and for this long after it ends (e.g. "I left my phone in the car"). */
export const CHAT_GRACE_MS = 24 * 60 * 60 * 1000;
export const MAX_MESSAGES_PER_MINUTE = 20;

/** Pure rule: can this ride's parties still talk? */
export function isChatOpen(ride: Pick<ChatRide, "driver_id" | "ended_at">, now = new Date()): boolean {
  if (!ride.driver_id) return false; // nobody to talk to yet
  if (!ride.ended_at) return true;
  return now.getTime() - ride.ended_at.getTime() <= CHAT_GRACE_MS;
}


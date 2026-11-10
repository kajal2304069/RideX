import { ApiError } from "../../../common/ApiError";
import { redis } from "../../../config/redis";
import { logger } from "../../../config/logger";
import { emitToRoom, rideRoom } from "../../../websocket/io";
import { chatRepository, ChatRide } from "../repositories/chat.repository";
import { isChatOpen, MAX_MESSAGES_PER_MINUTE } from "./chatRules";

export { isChatOpen, CHAT_GRACE_MS, MAX_MESSAGES_PER_MINUTE } from "./chatRules";

async function party(rideId: string, userId: string): Promise<ChatRide> {
  const ride = await chatRepository.findRide(rideId);
  // 404 (not 403) for non-parties: do not reveal that someone else's ride exists.
  if (!ride || (ride.rider_id !== userId && ride.driver_id !== userId)) throw ApiError.notFound("Ride not found");
  return ride;
}

/** Fixed-window counter per user+ride. Fails OPEN: a Redis outage must not silence a rider and driver coordinating a pickup. */
async function enforceRateLimit(userId: string, rideId: string) {
  try {
    const key = `ratelimit:chat:${rideId}:${userId}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 60);
    if (n > MAX_MESSAGES_PER_MINUTE) throw ApiError.tooManyRequests("You are sending messages too quickly");
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logger.warn({ err }, "Chat rate limit unavailable; allowing");
  }
}

export const chatService = {
  async send(userId: string, rideId: string, rawBody: string) {
    const ride = await party(rideId, userId);
    const body = rawBody.trim();
    if (!body) throw ApiError.badRequest("Message cannot be empty");
    if (!isChatOpen(ride)) throw ApiError.conflict(ride.driver_id ? "This chat is closed" : "Chat opens once a driver accepts the ride");
    await enforceRateLimit(userId, rideId);

    const m = await chatRepository.insert(rideId, userId, body);
    const message = { id: m.id, rideId, senderId: m.sender_id, body: m.body, createdAt: m.created_at };
    emitToRoom(rideRoom(rideId), "chat:message", message); // best effort: the message is already saved
    return message;
  },

  async list(userId: string, rideId: string, limit: number, cursor?: string) {
    await party(rideId, userId);
    const page = await chatRepository.list(rideId, limit, cursor);
    return {
      messages: page.items.map((m: any) => ({ id: m.id, senderId: m.sender_id, body: m.body, createdAt: m.created_at })),
      nextCursor: page.nextCursor,
    };
  },
};

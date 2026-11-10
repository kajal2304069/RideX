import Redis from "ioredis";
import { env } from "../../../config/env";
import { logger } from "../../../config/logger";
import { redis } from "../../../config/redis";
import { PublicNotification } from "../types/notifications.types";

export const NOTIFICATION_CHANNEL = "ridex:notifications:new";

export interface RealtimeNotification {
  userId: string;
  notification: PublicNotification;
}

/**
 * The worker may run in a different process from the one that holds the
 * Socket.IO connections, so it cannot call `emitToRoom` directly. Instead
 * it PUBLISHes here and every API process SUBSCRIBEs and emits to its own
 * sockets. (Socket.IO's Redis adapter solves the same problem for
 * broadcasts between API instances; this is the smaller version for
 * worker -> API.)
 *
 * Pub/sub is fire-and-forget: if no API process is listening the message
 * is dropped. That is acceptable because the notification is already
 * stored; the client sees it on its next fetch.
 */
export async function publishNotification(msg: RealtimeNotification): Promise<void> {
  await redis.publish(NOTIFICATION_CHANNEL, JSON.stringify(msg));
}

/** A subscriber connection can't issue normal commands, so it needs its own client. */
export async function startNotificationSubscriber(handler: (msg: RealtimeNotification) => void): Promise<() => Promise<void>> {
  const sub = new Redis(env.REDIS_URL);
  sub.on("error", (err) => logger.error({ err }, "Notification subscriber error"));
  sub.on("message", (_channel, raw) => {
    try {
      handler(JSON.parse(raw) as RealtimeNotification);
    } catch (err) {
      logger.warn({ err }, "Dropped malformed realtime notification");
    }
  });
  await sub.subscribe(NOTIFICATION_CHANNEL);
  return async () => {
    sub.disconnect();
  };
}

import { Server as SocketIOServer } from "socket.io";
import { logger } from "../config/logger";

/**
 * Services (rides.service.ts, drivers.service.ts, etc.) need to emit
 * real-time events after a REST mutation succeeds - e.g. "a ride was
 * just accepted, tell the rider" - but they're plain functions with no
 * access to Express's req/res, and threading the `io` instance through
 * every function signature in every module would leak a
 * transport-layer concern into business logic that shouldn't need to
 * know how it's reached.
 *
 * This module is the single place that concern lives: `server.ts` calls
 * `setIO()` once at boot after creating the real Socket.IO server; any
 * service can then call `getIO()` to emit, without importing
 * websocket/index.ts or knowing anything about HTTP servers.
 *
 * `getIO()` returns `null` (never throws) when no server has been set -
 * this matters because `createApp()` alone (used directly by most
 * integration tests, which exercise the REST layer via supertest
 * without booting a real listening HTTP+WebSocket server) never calls
 * `setIO()`. Emitting is therefore a best-effort side effect: a ride
 * mutation must succeed over REST regardless of whether anyone is
 * listening on a socket, exactly the same way it must succeed whether
 * or not push notifications (Phase 13) are configured.
 */
let ioInstance: SocketIOServer | null = null;

export function setIO(io: SocketIOServer): void {
  ioInstance = io;
}

export function getIO(): SocketIOServer | null {
  return ioInstance;
}

/** Best-effort emit to a room - silently does nothing if no socket server is running. Never throws, so a caller never needs to wrap this in try/catch just to protect its own success path. */
export function emitToRoom(room: string, event: string, payload: unknown): void {
  const io = getIO();
  if (!io) return;
  try {
    io.to(room).emit(event, payload);
  } catch (err) {
    logger.warn({ err, room, event }, "Failed to emit socket event");
  }
}

export const rideRoom = (rideId: string) => `ride:${rideId}`;
export const userRoom = (userId: string) => `user:${userId}`;

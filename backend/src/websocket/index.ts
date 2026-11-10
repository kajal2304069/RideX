import { Server as HttpServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { socketAuthMiddleware } from "./authMiddleware";
import { registerConnectionHandlers } from "./rideEventHandlers";

/**
 * Socket.IO bootstrap (spec section 11). Every connection is
 * authenticated with the same access tokens REST uses (authMiddleware.ts)
 * before it's ever accepted, then handed to registerConnectionHandlers
 * for the actual event wiring (ride:join, driver:location:update,
 * driver:online/offline) - this file stays pure wiring, consistent with
 * the Phase 1 layering rules applied to the WebSocket transport.
 */
export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.CLIENT_URL,
      credentials: true,
    },
    // Prevents a slow/dead client from holding a connection open forever -
    // a dropped connection is detected within pingTimeout of the last
    // missed pingInterval heartbeat, which is what lets the server (and,
    // via Phase 7's staleness mechanism, downstream nearby-search
    // results) eventually notice a driver who vanished without an
    // explicit disconnect.
    pingTimeout: 20000,
    pingInterval: 25000,
  });

  io.use(socketAuthMiddleware);
  registerConnectionHandlers(io);

  logger.info("Socket.IO server initialized");
  return io;
}

import { Server as SocketIOServer } from "socket.io";
import { logger } from "../config/logger";
import { ApiError } from "../common/ApiError";
import { locationService } from "../modules/location/services/location.service";
import { driversService } from "../modules/drivers/services/drivers.service";
import { ridesRepository } from "../modules/rides/repositories/rides.repository";
import { rideRoom, userRoom, emitToRoom } from "./io";
import { AuthenticatedSocket } from "./authMiddleware";

/**
 * Wraps a socket event handler so a thrown ApiError (or any error)
 * reaches the client as a structured `error` event instead of silently
 * doing nothing or crashing the connection - the socket equivalent of
 * the REST layer's centralized errorHandler middleware (Phase 1).
 */
function safeHandler(socket: AuthenticatedSocket, handler: (payload: unknown) => Promise<void>) {
  return async (payload: unknown) => {
    try {
      await handler(payload);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Something went wrong";
      const code = err instanceof ApiError ? err.code : "INTERNAL_ERROR";
      socket.emit("error", { code, message });
      logger.warn({ err, socketId: socket.id, userId: socket.data?.userId }, "Socket handler error");
    }
  };
}

export function registerConnectionHandlers(io: SocketIOServer): void {
  io.on("connection", (socket: AuthenticatedSocket) => {
    const { userId, roles } = socket.data;
    logger.debug({ socketId: socket.id, userId }, "Socket connected");

    // Every authenticated connection auto-joins its own personal room -
    // useful for direct-to-user pushes (e.g. Phase 13's notifications)
    // without needing a ride context.
    socket.join(userRoom(userId));

    /**
     * `ride:join` - a client subscribes to live updates for one specific
     * ride (driver location, status changes). Authorization mirrors
     * rides.service.ts's `assertParty` check: only the ride's rider or
     * its assigned driver may join that ride's room - otherwise any
     * authenticated user could eavesdrop on any ride's live location by
     * guessing/enumerating ride IDs, which the REST API already
     * prevents via the same check (Phase 6).
     *
     * RECONNECTION CONTRACT: Socket.IO's client automatically
     * reconnects on network drop (the pingTimeout/pingInterval
     * configured in index.ts detect a dead connection), but room
     * membership does NOT survive a reconnect - a new underlying
     * connection means a fresh `socket` server-side with no rooms
     * joined. The client is responsible for re-emitting `ride:join` for
     * any ride it cares about after a `connect` event fires again; this
     * is the standard Socket.IO pattern (the alternative - server-side
     * session/room persistence across reconnects - adds real complexity
     * for a benefit only needed at a scale this project isn't at).
     */
    socket.on(
      "ride:join",
      safeHandler(socket, async (payload) => {
        const { rideId } = payload as { rideId: string };
        const ride = await ridesRepository.findById(rideId);
        if (!ride) throw ApiError.notFound("Ride not found");
        if (ride.rider_id !== userId && ride.driver_id !== userId) {
          throw ApiError.notFound("Ride not found"); // same info-hiding as the REST layer
        }
        socket.join(rideRoom(rideId));
        socket.emit("ride:joined", { rideId });
      })
    );

    socket.on("ride:leave", (payload: { rideId: string }) => {
      socket.leave(rideRoom(payload.rideId));
    });

    /**
     * `driver:location:update` - the socket-transport equivalent of
     * `POST /api/location/drivers/me` (Phase 7). Calls the exact same
     * `locationService.recordDriverPing` the REST endpoint calls (no
     * duplicated eligibility logic), then - the part REST alone can't
     * do - broadcasts the new position to anyone subscribed to this
     * driver's active ride room, so a rider's map marker moves live
     * instead of requiring them to poll.
     */
    socket.on(
      "driver:location:update",
      safeHandler(socket, async (payload) => {
        if (!roles.includes("DRIVER")) {
          throw ApiError.forbidden("Only drivers can broadcast location");
        }
        const update = payload as { lat: number; lng: number; heading?: number; speedKmh?: number };
        await locationService.recordDriverPing(userId, update);

        const activeRide = await ridesRepository.findActiveByDriver(userId);
        if (activeRide) {
          emitToRoom(rideRoom(activeRide.id), "driver:location:update", {
            rideId: activeRide.id,
            driverId: userId,
            lat: update.lat,
            lng: update.lng,
            heading: update.heading ?? null,
            speedKmh: update.speedKmh ?? null,
            updatedAt: Date.now(),
          });
        }
      })
    );

    /**
     * `rider:location:update` - the mirror of driver:location:update, so the driver can see where the customer is
     * standing while they come to the pickup. Purely a relay into the ride room: nothing is stored, and it only works
     * for a rider who has a ride with a driver already assigned (nobody can broadcast a position to a stranger's room).
     */
    socket.on(
      "rider:location:update",
      safeHandler(socket, async (payload) => {
        if (!roles.includes("RIDER")) throw ApiError.forbidden("Only riders can share rider location");
        const u = payload as { lat?: unknown; lng?: unknown; accuracy?: unknown };
        const lat = Number(u?.lat), lng = Number(u?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          throw ApiError.badRequest("A valid latitude and longitude are required");
        }
        const ride = await ridesRepository.findActiveByRider(userId);
        if (!ride || !ride.driver_id) return; // nobody to show it to yet
        const accuracy = Number(u.accuracy);
        emitToRoom(rideRoom(ride.id), "rider:location:update", {
          rideId: ride.id, riderId: userId, lat, lng, accuracy: Number.isFinite(accuracy) ? accuracy : null, updatedAt: Date.now(),
        });
      })
    );

    socket.on(
      "driver:online",
      safeHandler(socket, async () => {
        if (!roles.includes("DRIVER")) throw ApiError.forbidden("Only drivers can go online");
        const driver = await driversService.goOnline(userId);
        socket.emit("driver:online", driver);
      })
    );

    socket.on(
      "driver:offline",
      safeHandler(socket, async () => {
        if (!roles.includes("DRIVER")) throw ApiError.forbidden("Only drivers can go offline");
        const driver = await driversService.goOffline(userId);
        socket.emit("driver:offline", driver);
      })
    );

    /**
     * Deliberately NOT calling driversService.goOffline() here. A
     * socket disconnect can mean many things - a network blip, the app
     * backgrounding briefly, a phone entering a tunnel - most of which
     * are NOT "the driver quit for the day." Treating every disconnect
     * as an explicit sign-off would be wrong (and punishing: a driver
     * losing signal for 5 seconds shouldn't lose their place in
     * nearby-search results and have to explicitly go online again).
     * Phase 7's staleness mechanism already handles the case that
     * actually matters here (a driver who never reconnects at all) by
     * aging their location out of Redis GEO after 30 seconds of no
     * pings - this disconnect handler's job is just observability
     * logging, not a state transition.
     */
    socket.on("disconnect", (reason) => {
      logger.debug({ socketId: socket.id, userId, reason }, "Socket disconnected");
    });
  });
}

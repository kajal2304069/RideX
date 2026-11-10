import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { ridesService } from "../services/rides.service";

export const ridesController = {
  rate: asyncHandler(async (req, res) => sendSuccess(res, await ridesService.rate(req.params.rideId, req.user!.sub, req.body), 201)),
  myRating: asyncHandler(async (req, res) => sendSuccess(res, await ridesService.myRating(req.params.rideId, req.user!.sub))),

  estimate: asyncHandler(async (req, res) => {
    const result = await ridesService.estimate(req.body.pickup, req.body.dropoff, req.body.vehicleTypeId);
    sendSuccess(res, result);
  }),

  request: asyncHandler(async (req, res) => {
    const ride = await ridesService.request(req.user!.sub, req.body);
    sendSuccess(res, { ride }, 201);
  }),

  getCurrent: asyncHandler(async (req, res) => {
    const ride = await ridesService.getCurrentForRider(req.user!.sub);
    sendSuccess(res, { ride });
  }),

  getCurrentForDriver: asyncHandler(async (req, res) => {
    const ride = await ridesService.getCurrentForDriver(req.user!.sub);
    sendSuccess(res, { ride });
  }),

  getHistory: asyncHandler(async (req, res) => {
    const rides = await ridesService.getHistory(req.user!.sub);
    sendSuccess(res, { rides });
  }),

  getOne: asyncHandler(async (req, res) => {
    const ride = await ridesService.getOne(req.params.rideId, req.user!.sub);
    sendSuccess(res, { ride });
  }),

  listAvailable: asyncHandler(async (req, res) => {
    const vehicleTypeId = typeof req.query.vehicleTypeId === "string" ? req.query.vehicleTypeId : undefined;
    const rides = await ridesService.listAvailableForDrivers(vehicleTypeId);
    sendSuccess(res, { rides });
  }),

  accept: asyncHandler(async (req, res) => {
    const ride = await ridesService.accept(req.params.rideId, req.user!.sub);
    sendSuccess(res, { ride });
  }),

  markArriving: asyncHandler(async (req, res) => {
    const ride = await ridesService.transition(req.params.rideId, req.user!.sub, "DRIVER_ARRIVING");
    sendSuccess(res, { ride });
  }),

  markArrived: asyncHandler(async (req, res) => {
    const ride = await ridesService.transition(req.params.rideId, req.user!.sub, "DRIVER_ARRIVED", "arrived_at");
    sendSuccess(res, { ride });
  }),

  start: asyncHandler(async (req, res) => {
    const ride = await ridesService.transition(req.params.rideId, req.user!.sub, "TRIP_STARTED", "started_at");
    sendSuccess(res, { ride });
  }),

  complete: asyncHandler(async (req, res) => {
    const ride = await ridesService.complete(req.params.rideId, req.user!.sub);
    sendSuccess(res, { ride });
  }),

  cancel: asyncHandler(async (req, res) => {
    const ride = await ridesService.cancel(req.params.rideId, req.user!.sub, req.body.reason);
    sendSuccess(res, { ride });
  }),
};

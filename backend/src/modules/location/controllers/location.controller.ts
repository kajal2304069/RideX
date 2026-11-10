import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { locationService } from "../services/location.service";

export const locationController = {
  updateMine: asyncHandler(async (req, res) => {
    await locationService.recordDriverPing(req.user!.sub, req.body);
    sendSuccess(res, { updated: true });
  }),

  nearbyDrivers: asyncHandler(async (req, res) => {
    const { lat, lng, radiusMeters, vehicleTypeId } = req.query as unknown as {
      lat: number;
      lng: number;
      radiusMeters: number;
      vehicleTypeId?: string;
    };
    const drivers = await locationService.getNearbyDrivers(lat, lng, radiusMeters, vehicleTypeId);
    sendSuccess(res, { drivers });
  }),
};

import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { matchingService } from "../services/matching.service";
import { ridesService } from "../../rides/services/rides.service";

export const matchingController = {
  findCandidates: asyncHandler(async (req, res) => {
    // Reuses ride.getOne's existing party-based visibility check (rider
    // or assigned driver only) rather than duplicating it - an ADMIN can
    // also always view candidates for operational visibility.
    if (!req.user!.roles.includes("ADMIN")) {
      await ridesService.getOne(req.params.rideId, req.user!.sub);
    }

    const result = await matchingService.findCandidates(req.params.rideId);
    sendSuccess(res, result);
  }),
};

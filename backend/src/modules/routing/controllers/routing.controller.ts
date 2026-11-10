import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { routingService } from "../services/routing.service";

export const routingController = {
  computeRoute: asyncHandler(async (req, res) => {
    const route = await routingService.computeRoute(req.body.from, req.body.to);
    sendSuccess(res, route);
  }),
};

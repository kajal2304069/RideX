import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { ridersService } from "../services/riders.service";

export const ridersController = {
  me: asyncHandler(async (req, res) => {
    const profile = await ridersService.getMyProfile(req.user!.sub);
    sendSuccess(res, { rider: profile });
  }),
};

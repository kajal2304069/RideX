import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { chatService } from "../services/chat.service";

export const chatController = {
  send: asyncHandler(async (req, res) => sendSuccess(res, { message: await chatService.send(req.user!.sub, req.params.rideId, req.body.body) }, 201)),
  list: asyncHandler(async (req, res) => {
    const q = req.query as unknown as { limit: number; cursor?: string };
    sendSuccess(res, await chatService.list(req.user!.sub, req.params.rideId, q.limit, q.cursor));
  }),
};

import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { assistantService } from "../services/assistant.service";

export const assistantController = {
  languages: asyncHandler(async (_req, res) => sendSuccess(res, { languages: assistantService.languages(), aiEnabled: assistantService.aiEnabled() })),
  ask: asyncHandler(async (req, res) => sendSuccess(res, await assistantService.ask(req.body))),
};

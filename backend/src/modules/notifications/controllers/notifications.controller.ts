import { asyncHandler } from "../../../common/asyncHandler";
import { sendSuccess } from "../../../common/ApiResponse";
import { notificationsService } from "../services/notifications.service";

export const notificationsController = {
  list: asyncHandler(async (req, res) => {
    const q = req.query as unknown as { limit: number; unreadOnly: string; before?: Date };
    const notifications = await notificationsService.list(req.user!.sub, { limit: q.limit, unreadOnly: q.unreadOnly === "true", before: q.before });
    sendSuccess(res, { notifications });
  }),

  unreadCount: asyncHandler(async (req, res) => {
    sendSuccess(res, { unread: await notificationsService.unreadCount(req.user!.sub) });
  }),

  markRead: asyncHandler(async (req, res) => {
    sendSuccess(res, { notification: await notificationsService.markRead(req.params.notificationId, req.user!.sub) });
  }),

  markAllRead: asyncHandler(async (req, res) => {
    sendSuccess(res, { updated: await notificationsService.markAllRead(req.user!.sub) });
  }),

  queueStats: asyncHandler(async (_req, res) => {
    sendSuccess(res, { queue: await notificationsService.queueStats() });
  }),
};

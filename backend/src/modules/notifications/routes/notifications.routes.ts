import { Router } from "express";
import { authenticate, authorize } from "../../../middleware/auth";
import { validate } from "../../../middleware/validate";
import { notificationsController } from "../controllers/notifications.controller";
import { listNotificationsSchema, notificationIdParamSchema } from "../validators/notifications.validators";

export const notificationsRouter = Router();

// Fixed paths are registered before "/:notificationId" so they are not captured as an id.
notificationsRouter.get("/", authenticate, validate(listNotificationsSchema), notificationsController.list);
notificationsRouter.get("/unread-count", authenticate, notificationsController.unreadCount);
notificationsRouter.get("/admin/queue-stats", authenticate, authorize("ADMIN"), notificationsController.queueStats);
notificationsRouter.post("/read-all", authenticate, notificationsController.markAllRead);
notificationsRouter.patch("/:notificationId/read", authenticate, validate(notificationIdParamSchema), notificationsController.markRead);

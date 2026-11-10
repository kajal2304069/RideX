import { closeNotificationQueue } from "../src/queues/notificationQueue";
import { closeMarketplaceQueue } from "../src/queues/marketplaceQueue";
import { closeMaintenanceQueue } from "../src/queues/maintenanceQueue";
import { closeRentalQueue } from "../src/queues/rentalQueue";
import { closeBullMQConnection } from "../src/config/bullmqConnection";

// Any test file that triggers a notification opens a BullMQ queue/connection.
// Closing them here stops Jest from hanging on open handles.
afterAll(async () => {
  await closeNotificationQueue();
  await closeMarketplaceQueue();
  await closeRentalQueue();
  await closeMaintenanceQueue();
  await closeBullMQConnection();
});

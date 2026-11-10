import { UnrecoverableError } from "bullmq";
import { NotificationRecord } from "../../src/modules/notifications/types/notifications.types";
import { renderNotification } from "../../src/modules/notifications/services/templates";
import { MockEmailChannel, setEmailChannelForTests } from "../../src/modules/notifications/services/channels/EmailChannel";

jest.mock("../../src/modules/notifications/repositories/notifications.repository", () => ({
  notificationsRepository: {
    insertIfAbsent: jest.fn(),
    markEmailSent: jest.fn(),
    findUserContact: jest.fn(),
    list: jest.fn(),
    countUnread: jest.fn(),
    markRead: jest.fn(),
    markAllRead: jest.fn(),
  },
}));
jest.mock("../../src/modules/notifications/services/realtimeBridge", () => ({ publishNotification: jest.fn() }));
jest.mock("../../src/queues/notificationQueue", () => ({ getNotificationQueue: jest.fn() }));
jest.mock("../../src/config/logger", () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));

import { notificationsRepository } from "../../src/modules/notifications/repositories/notifications.repository";
import { publishNotification } from "../../src/modules/notifications/services/realtimeBridge";
import { getNotificationQueue } from "../../src/queues/notificationQueue";
import { buildDedupeKey, notificationsService } from "../../src/modules/notifications/services/notifications.service";

const repo = notificationsRepository as jest.Mocked<typeof notificationsRepository>;
const publish = publishNotification as jest.Mock;
const getQueue = getNotificationQueue as jest.Mock;

const USER = "11111111-1111-1111-1111-111111111111";

function row(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "n-1", user_id: USER, type: "RIDE_COMPLETED", title: "t", body: "b", data: {}, read_at: null,
    created_at: new Date(), dedupe_key: "RIDE_COMPLETED__r1", email_sent_at: null, ...over,
  };
}

let email: MockEmailChannel;
beforeEach(() => {
  jest.resetAllMocks();
  email = new MockEmailChannel();
  setEmailChannelForTests(email);
  repo.findUserContact.mockResolvedValue({ email: "rider@ridex.dev", full_name: "Rider" });
  repo.insertIfAbsent.mockResolvedValue({ row: row(), inserted: true });
  publish.mockResolvedValue(undefined);
});

describe("templates", () => {
  it("renders the fare into RIDE_COMPLETED and asks for an email", () => {
    const r = renderNotification("RIDE_COMPLETED", { totalFare: 123.5, currency: "INR" });
    expect(r.body).toContain("INR 123.50");
    expect(r.email).toBe(true);
  });
  it("keeps chatty events in-app only", () => {
    expect(renderNotification("DRIVER_ARRIVED", {}).email).toBe(false);
  });
  it("throws for an unknown type", () => {
    expect(() => renderNotification("NOPE" as never, {})).toThrow();
  });
});

describe("garage booking templates", () => {
  it("flags an emergency request loudly and emails the garage only for emergencies", () => {
    const normal = renderNotification("BOOKING_REQUESTED", { isEmergency: false });
    const urgent = renderNotification("BOOKING_REQUESTED", { isEmergency: true });
    expect(normal.title).toBe("New service booking");
    expect(normal.email).toBe(false);
    expect(urgent.title).toMatch(/EMERGENCY/);
    expect(urgent.email).toBe(true);
  });
  it("BOOKING_READY states the amount due and emails the customer", () => {
    const r = renderNotification("BOOKING_READY", { totalCost: 1100.99, currency: "INR" });
    expect(r.body).toContain("INR 1100.99");
    expect(r.email).toBe(true);
  });
  it("BOOKING_CANCELLED names who cancelled", () => {
    expect(renderNotification("BOOKING_CANCELLED", { cancelledBy: "GARAGE" }).body).toMatch(/garage cancelled/i);
    expect(renderNotification("BOOKING_CANCELLED", { cancelledBy: "CUSTOMER" }).body).toMatch(/customer cancelled/i);
  });
});

describe("buildDedupeKey", () => {
  it("never contains ':' (BullMQ job ids can't)", () => {
    expect(buildDedupeKey("RIDE_ASSIGNED", "abc")).not.toContain(":");
  });
});

describe("notificationsService.notify (producer)", () => {
  it("enqueues with a deterministic jobId", async () => {
    const add = jest.fn().mockResolvedValue({});
    getQueue.mockReturnValue({ add });

    await notificationsService.notify(USER, "RIDE_ASSIGNED", "r1", { x: 1 });

    expect(add).toHaveBeenCalledWith("RIDE_ASSIGNED", { userId: USER, type: "RIDE_ASSIGNED", entityId: "r1", data: { x: 1 } }, { jobId: `RIDE_ASSIGNED__r1__${USER}` });
  });

  it("never throws when the queue is down", async () => {
    getQueue.mockReturnValue({ add: jest.fn().mockRejectedValue(new Error("redis down")) });
    await expect(notificationsService.notify(USER, "RIDE_ASSIGNED", "r1")).resolves.toBeUndefined();
  });
});

describe("notificationsService.process (consumer)", () => {
  const job = { userId: USER, type: "RIDE_COMPLETED" as const, entityId: "r1", data: { totalFare: 100, currency: "INR" } };

  it("stores, publishes live, then emails and stamps email_sent_at", async () => {
    await notificationsService.process(job);

    expect(repo.insertIfAbsent).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "RIDE_COMPLETED__r1", userId: USER }));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe("rider@ridex.dev");
    expect(repo.markEmailSent).toHaveBeenCalledWith("n-1");
  });

  it("does not email in-app-only types", async () => {
    await notificationsService.process({ ...job, type: "DRIVER_ARRIVED" });
    expect(email.sent).toHaveLength(0);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("on a duplicate (row already exists) does not publish again and does not re-send an already-sent email", async () => {
    repo.insertIfAbsent.mockResolvedValue({ row: row({ email_sent_at: new Date() }), inserted: false });

    await notificationsService.process(job);

    expect(publish).not.toHaveBeenCalled();
    expect(email.sent).toHaveLength(0);
  });

  it("on a retry after an email failure sends the email without publishing a second live event", async () => {
    repo.insertIfAbsent.mockResolvedValue({ row: row({ email_sent_at: null }), inserted: false });

    await notificationsService.process(job);

    expect(publish).not.toHaveBeenCalled();
    expect(email.sent).toHaveLength(1);
  });

  it("propagates an email failure so BullMQ retries, and does not stamp email_sent_at", async () => {
    email.failNext(1);
    await expect(notificationsService.process(job)).rejects.toThrow("Mock email provider unavailable");
    expect(repo.markEmailSent).not.toHaveBeenCalled();
  });

  it("a failed realtime publish does not fail the job", async () => {
    publish.mockRejectedValue(new Error("pubsub down"));
    await expect(notificationsService.process(job)).resolves.toBeUndefined();
    expect(email.sent).toHaveLength(1);
  });

  it("fails permanently (UnrecoverableError) for a user that does not exist", async () => {
    repo.findUserContact.mockResolvedValue(null);
    await expect(notificationsService.process(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(repo.insertIfAbsent).not.toHaveBeenCalled();
  });
});

describe("notificationsService.markRead", () => {
  it("404s when the notification is not the caller's", async () => {
    repo.markRead.mockResolvedValue(null);
    await expect(notificationsService.markRead("n-1", USER)).rejects.toMatchObject({ statusCode: 404 });
  });
});

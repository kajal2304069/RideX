export type NotificationType =
  | "RIDE_ASSIGNED"
  | "DRIVER_ARRIVING"
  | "DRIVER_ARRIVED"
  | "TRIP_STARTED"
  | "RIDE_COMPLETED"
  | "RIDE_CANCELLED"
  | "PAYMENT_SUCCESS"
  | "PAYMENT_RECEIVED"
  | "PAYMENT_REFUNDED"
  | "BOOKING_REQUESTED"
  | "BOOKING_ACCEPTED"
  | "MECHANIC_ASSIGNED"
  | "VEHICLE_RECEIVED"
  | "BOOKING_READY"
  | "BOOKING_CANCELLED"
  | "BOOKING_PAID"
  | "OFFER_RECEIVED"
  | "OFFER_ACCEPTED"
  | "OFFER_REJECTED"
  | "OFFER_EXPIRED"
  | "INSPECTION_SCHEDULED"
  | "INSPECTION_COMPLETED"
  | "LISTING_SOLD"
  | "RENTAL_BOOKED"
  | "RENTAL_CONFIRMED"
  | "RENTAL_STARTED"
  | "RENTAL_COMPLETED"
  | "RENTAL_CANCELLED"
  | "RENTAL_EXPIRED"
  | "PAYOUT_PAID"
  | "DEPOSIT_REFUNDED"
  | "SUPPORT_REPLY"
  | "SUPPORT_RESOLVED"
  | "SERVICE_DUE"
  | "DOCUMENT_EXPIRING";

/** The payload placed on the queue. Small and serializable: ids and facts, never rendered text. */
export interface NotificationJob {
  userId: string;
  type: NotificationType;
  /** Identifies the underlying event (rideId, paymentId). Together with type + user it forms the dedupe key. */
  entityId: string;
  data: Record<string, unknown>;
}

export interface NotificationRecord {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
  read_at: Date | null;
  created_at: Date;
  dedupe_key: string | null;
  email_sent_at: Date | null;
}

export interface PublicNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
  readAt: Date | null;
  createdAt: Date;
}

export function toPublicNotification(n: NotificationRecord): PublicNotification {
  return { id: n.id, type: n.type, title: n.title, body: n.body, data: n.data, readAt: n.read_at, createdAt: n.created_at };
}

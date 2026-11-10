import { NotificationType } from "../types/notifications.types";

export interface RenderedNotification {
  title: string;
  body: string;
  /** Whether this type is also sent by email. Chatty, time-critical events stay in-app only. */
  email: boolean;
}

const money = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : "0.00");

/**
 * Text is rendered in the WORKER, not at enqueue time. Jobs carry facts
 * (ids, amounts); wording can change and queued jobs pick up the new copy.
 * It also keeps job payloads small and free of anything that would need
 * escaping.
 */
const templates: Record<NotificationType, (d: Record<string, unknown>) => RenderedNotification> = {
  RIDE_ASSIGNED: () => ({ title: "Driver assigned", body: "A driver accepted your ride and is on the way.", email: false }),
  DRIVER_ARRIVING: () => ({ title: "Driver is arriving", body: "Your driver is heading to your pickup point.", email: false }),
  DRIVER_ARRIVED: () => ({ title: "Driver has arrived", body: "Your driver is at the pickup point.", email: false }),
  TRIP_STARTED: () => ({ title: "Trip started", body: "Your trip has begun. Have a safe ride.", email: false }),
  RIDE_COMPLETED: (d) => ({
    title: "Trip completed",
    body: `You've arrived. Your fare is ${d.currency ?? "INR"} ${money(d.totalFare)}. Please complete the payment.`,
    email: true,
  }),
  RIDE_CANCELLED: (d) => ({
    title: "Ride cancelled",
    body: d.cancelledBy === "DRIVER" ? "Your driver cancelled the ride." : "The rider cancelled the ride.",
    email: false,
  }),
  PAYMENT_SUCCESS: (d) => ({
    title: "Payment received",
    body: `We received your payment of ${d.currency ?? "INR"} ${money(d.amount)}. Thank you!`,
    email: true,
  }),
  PAYMENT_RECEIVED: () => ({ title: "Ride paid", body: "The rider has paid for your completed trip.", email: false }),
  PAYMENT_REFUNDED: (d) => ({
    title: "Payment refunded",
    body: `Your payment of ${d.currency ?? "INR"} ${money(d.amount)} was refunded.`,
    email: true,
  }),
  BOOKING_REQUESTED: (d) => ({
    title: d.isEmergency ? "EMERGENCY breakdown request" : "New service booking",
    body: d.isEmergency ? "A customer needs urgent roadside help. Please respond immediately." : "A customer requested a service at your garage.",
    email: Boolean(d.isEmergency),
  }),
  BOOKING_ACCEPTED: () => ({ title: "Booking accepted", body: "The garage accepted your service booking.", email: false }),
  MECHANIC_ASSIGNED: () => ({ title: "Mechanic assigned", body: "A mechanic has been assigned to your booking.", email: false }),
  VEHICLE_RECEIVED: () => ({ title: "Vehicle received", body: "The garage has received your vehicle.", email: false }),
  BOOKING_READY: (d) => ({
    title: "Your vehicle is ready",
    body: `The repair is finished. Total due: ${d.currency ?? "INR"} ${money(d.totalCost)}. Please pay to collect your vehicle.`,
    email: true,
  }),
  BOOKING_CANCELLED: (d) => ({
    title: "Booking cancelled",
    body: d.cancelledBy === "GARAGE" ? "The garage cancelled your booking." : "The customer cancelled the booking.",
    email: false,
  }),
  OFFER_RECEIVED: (d) => ({ title: "New offer on your listing", body: `You received an offer of ${d.currency ?? "INR"} ${money(d.amount)}.`, email: false }),
  OFFER_ACCEPTED: (d) => ({
    title: "Your offer was accepted",
    body: `The seller accepted your offer of ${d.currency ?? "INR"} ${money(d.amount)}. Pay within ${d.payWithinHours ?? 48} hours to secure the vehicle.`,
    email: true,
  }),
  OFFER_REJECTED: () => ({ title: "Offer not accepted", body: "The seller did not accept your offer.", email: false }),
  OFFER_EXPIRED: () => ({ title: "Offer expired", body: "The accepted offer was not paid in time and has expired. The listing is open again.", email: true }),
  INSPECTION_SCHEDULED: () => ({ title: "Inspection requested", body: "A buyer scheduled an inspection of your vehicle.", email: false }),
  INSPECTION_COMPLETED: (d) => ({ title: "Inspection report ready", body: `The inspection is complete. Overall score: ${d.overallScore ?? "n/a"}/10.`, email: true }),
  LISTING_SOLD: (d) => ({ title: "Your vehicle sold", body: `Your listing sold for ${d.currency ?? "INR"} ${money(d.amount)}.`, email: true }),
  RENTAL_BOOKED: () => ({ title: "Your vehicle was booked", body: "A renter booked and paid for your vehicle. Check the pickup time.", email: true }),
  RENTAL_CONFIRMED: () => ({ title: "Rental confirmed", body: "Your payment was received and your rental is confirmed.", email: true }),
  RENTAL_STARTED: () => ({ title: "Rental started", body: "The owner handed over the vehicle. Drive safe, and return it on time.", email: false }),
  RENTAL_COMPLETED: (d) => ({
    title: "Rental completed",
    body: `The vehicle was returned. Deposit to be returned: ${d.currency ?? "INR"} ${money(d.depositRefundDue)}.`,
    email: true,
  }),
  RENTAL_CANCELLED: (d) => ({
    title: "Rental cancelled",
    body: d.cancelledBy === "OWNER" ? "The owner cancelled the rental." : "The renter cancelled the rental.",
    email: true,
  }),
  PAYOUT_PAID: (d) => ({ title: "Withdrawal sent", body: `${d.currency ?? "INR"} ${money(d.amount)} is on its way to you.`, email: true }),
  DEPOSIT_REFUNDED: (d) => ({ title: "Deposit returned", body: `Your security deposit refund of ${d.currency ?? "INR"} ${money(d.amount)} was sent.`, email: true }),
  SUPPORT_REPLY: (d) => ({ title: "Support replied", body: `We replied to your ticket "${d.subject ?? ""}".`, email: true }),
  SUPPORT_RESOLVED: (d) => ({ title: "Ticket resolved", body: `Your ticket "${d.subject ?? ""}" was marked resolved. Reply if it is not.`, email: false }),
  SERVICE_DUE: (d) => ({
    title: d.stage === "OVERDUE" ? "Service overdue" : "Service due soon",
    body: `${d.vehicle ?? "Your vehicle"}: ${String(d.serviceType ?? "service").replace(/_/g, " ").toLowerCase()} ${d.stage === "OVERDUE" ? "is overdue" : "is due " + (d.dueOn ?? "soon")}.`,
    email: true,
  }),
  DOCUMENT_EXPIRING: (d) => ({
    title: d.stage === "EXPIRED" ? "Document expired" : "Document expiring",
    body: `${d.vehicle ?? "Your vehicle"}: ${String(d.docType ?? "document").toLowerCase()} ${d.stage === "EXPIRED" ? "has expired" : "expires on " + (d.expiresOn ?? "soon")}.`,
    email: true,
  }),
  RENTAL_EXPIRED: () => ({ title: "Booking expired", body: "The booking was not paid in time and was released.", email: false }),
  BOOKING_PAID: () => ({ title: "Booking paid", body: "The customer has paid for the completed repair.", email: false }),
};

export function renderNotification(type: NotificationType, data: Record<string, unknown>): RenderedNotification {
  const render = templates[type];
  if (!render) throw new Error(`No template for notification type ${type}`);
  return render(data);
}

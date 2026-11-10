import request from "supertest";
import { Worker } from "bullmq";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { env } from "../../src/config/env";
import { closeTestDb } from "./testUtils";
import { makeAdmin } from "./paymentFixtures";
import { getRentalQueue } from "../../src/queues/rentalQueue";
import { startRentalWorker } from "../../src/workers/rentalWorker";
import { rentalBookingsService } from "../../src/modules/rentals/services/rentalBookings.service";
import {
  bearer, book, bookOk, bookingRow, bookingStatus, confirmedBooking, createRentalListing, ensureRentalVehicleType, hoursFromNow, idemKey,
  lapseHold, moveWindow, payBooking, registerOwner, registerRenter, resetRentalTables, vehicleStatus,
} from "./rentalFixtures";

const app = createApp();
let vt: string;

const act = (t: { accessToken: string }, bookingId: string, action: "cancel" | "start" | "complete", body: object = {}) =>
  request(app).post(`/api/rentals/bookings/${bookingId}/${action}`).set(bearer(t.accessToken)).send(body);
const payment = async (bookingId: string) =>
  (await pool.query(`SELECT * FROM payments WHERE payable_type = 'RENTAL' AND payable_id = $1 ORDER BY created_at DESC LIMIT 1`, [bookingId])).rows[0];

async function setup() {
  const owner = await registerOwner(app);
  const renter = await registerRenter(app);
  const listing = await createRentalListing(app, owner, vt); // 100/h, 800/day, deposit 2000
  return { owner, renter, listing };
}

describe("Rental bookings: holds, payment, expiry, cancellation, handover, return (live DB + Redis + worker)", () => {
  beforeAll(async () => { vt = await ensureRentalVehicleType("RNT_BOOK_BOTH", "BOTH"); });
  beforeEach(async () => { await resetRentalTables(); await redis.flushdb(); });
  afterAll(async () => { await closeTestDb(); redis.disconnect(); });

  describe("creating a booking", () => {
    it("creates a PENDING_PAYMENT hold priced by the server, with a payment deadline and an expiry job", async () => {
      const { renter, listing } = await setup();
      const res = await book(app, renter, listing.id, hoursFromNow(48), hoursFromNow(53));
      expect(res.status).toBe(201);
      const b = res.body.data.booking;
      expect(b).toMatchObject({ status: "PENDING_PAYMENT", rentAmount: 500, depositAmount: 2000, totalDue: 2500, listingId: listing.id });
      const due = new Date(b.paymentDueAt).getTime() - Date.now();
      expect(due).toBeGreaterThan(env.RENTAL_PAYMENT_HOLD_MS - 5000);
      expect(due).toBeLessThanOrEqual(env.RENTAL_PAYMENT_HOLD_MS);

      const delayed = await getRentalQueue().getDelayed();
      const job = delayed.find((j) => j.id === `expire-booking__${b.id}`);
      expect(job?.opts.delay).toBe(env.RENTAL_PAYMENT_HOLD_MS);
    });

    it("rejects client-supplied prices, bad windows, short keys; wrong role; unknown/own/inactive listings", async () => {
      const { owner, renter, listing } = await setup();
      const post = (t: string, body: object, id = listing.id) => request(app).post(`/api/rentals/listings/${id}/bookings`).set(bearer(t)).send(body);
      const ok = { startAt: hoursFromNow(48).toISOString(), endAt: hoursFromNow(53).toISOString(), idempotencyKey: idemKey() };

      expect((await post(renter.accessToken, { ...ok, totalAmount: 1 })).status).toBe(400);
      expect((await post(renter.accessToken, { ...ok, idempotencyKey: "short" })).status).toBe(400);
      expect((await post(renter.accessToken, { ...ok, startAt: "nope" })).status).toBe(400);
      expect((await post(renter.accessToken, { ...ok, startAt: hoursFromNow(-2).toISOString() })).status).toBe(400); // past
      expect((await post(renter.accessToken, { ...ok, endAt: hoursFromNow(48).toISOString() })).status).toBe(400); // zero length
      expect((await post(renter.accessToken, { ...ok, endAt: hoursFromNow(47).toISOString() })).status).toBe(400); // end before start
      expect((await post(renter.accessToken, { ...ok, endAt: hoursFromNow(48.5).toISOString() })).status).toBe(400); // under 1h
      expect((await post(renter.accessToken, { ...ok, endAt: hoursFromNow(48 + 31 * 24).toISOString() })).status).toBe(400); // over 30 days
      expect((await post(renter.accessToken, { ...ok, startAt: hoursFromNow(181 * 24).toISOString(), endAt: hoursFromNow(181 * 24 + 5).toISOString() })).status).toBe(400);
      expect((await post(owner.accessToken, ok)).status).toBe(403); // VEHICLE_OWNER only
      expect((await request(app).post(`/api/rentals/listings/${listing.id}/bookings`).send(ok)).status).toBe(401);
      expect((await post(renter.accessToken, ok, "00000000-0000-4000-8000-000000000000")).status).toBe(404);

      const both = await (await import("./paymentFixtures")).registerUser(app, ["VEHICLE_OWNER", "RIDER"]);
      const mine = await createRentalListing(app, both, vt);
      expect((await post(both.accessToken, ok, mine.id)).status).toBe(400); // cannot rent your own vehicle
    });

    it("keeps the price it was booked at even if the owner changes prices afterwards", async () => {
      const { owner, renter, listing } = await setup();
      const b = await bookOk(app, renter, listing.id);
      await request(app).patch(`/api/rentals/listings/${listing.id}`).set(bearer(owner.accessToken)).send({ hourlyPrice: 999, securityDeposit: 9999 });
      const pay = await payBooking(app, renter, b.id);
      expect(pay.body.data.payment.amount).toBe(2500);
    });
  });

  describe("no double booking", () => {
    it("refuses overlaps, allows adjacent windows (half-open ranges) and other listings", async () => {
      const { owner, renter, listing } = await setup();
      const other = await registerRenter(app);
      const l2 = await createRentalListing(app, owner, vt);
      // One fixed "now", so adjacent windows really touch (separate Date.now() calls would drift by a few ms).
      const base = Date.now();
      const at = (h: number) => new Date(base + h * 3_600_000);
      expect((await book(app, renter, listing.id, at(48), at(53))).status).toBe(201);

      const try_ = (a: number, b: number, id = listing.id) => book(app, other, id, at(a), at(b));
      expect((await try_(48, 53)).status).toBe(409); // identical
      expect((await try_(50, 55)).status).toBe(409); // overlaps the end
      expect((await try_(45, 49)).status).toBe(409); // overlaps the start
      expect((await try_(49, 52)).status).toBe(409); // inside
      expect((await try_(40, 60)).status).toBe(409); // surrounds
      expect((await try_(53, 58)).status).toBe(201); // starts exactly when the first ends
      expect((await try_(43, 48)).status).toBe(201); // ends exactly when the first starts
      expect((await try_(48, 53, l2.id)).status).toBe(201); // different vehicle
    });

    it("a cancelled or expired booking frees the dates", async () => {
      const { renter, listing } = await setup();
      const other = await registerRenter(app);
      const a = await bookOk(app, renter, listing.id, 48, 53);
      expect((await book(app, other, listing.id, hoursFromNow(48), hoursFromNow(53))).status).toBe(409);
      await act(renter, a.id, "cancel");
      const b = await book(app, other, listing.id, hoursFromNow(48), hoursFromNow(53));
      expect(b.status).toBe(201);

      await pool.query(`UPDATE rental_bookings SET status = 'EXPIRED' WHERE id = $1`, [b.body.data.booking.id]);
      expect((await book(app, renter, listing.id, hoursFromNow(48), hoursFromNow(53))).status).toBe(201);
    });

    it("a lapsed hold (job not run yet) does not block the next renter and is expired on the spot", async () => {
      const { renter, listing } = await setup();
      const other = await registerRenter(app);
      const a = await bookOk(app, renter, listing.id, 48, 53);
      await lapseHold(a.id, 60_000);
      expect((await book(app, other, listing.id, hoursFromNow(48), hoursFromNow(53))).status).toBe(201);
      expect(await bookingStatus(a.id)).toBe("EXPIRED");
    });

    it("a live hold is NOT cleared by a competing booking", async () => {
      const { renter, listing } = await setup();
      const other = await registerRenter(app);
      const a = await bookOk(app, renter, listing.id, 48, 53);
      expect((await book(app, other, listing.id, hoursFromNow(48), hoursFromNow(53))).status).toBe(409);
      expect(await bookingStatus(a.id)).toBe("PENDING_PAYMENT");
    });

    it("the database exclusion constraint refuses overlapping holding rows, even when the app is bypassed", async () => {
      const { renter, listing } = await setup();
      const ins = (status: string, a: number, b: number) => pool.query(
        `INSERT INTO rental_bookings (rental_listing_id, renter_id, status, start_at, end_at, total_amount, deposit_amount)
         VALUES ($1, $2, $3::rental_booking_status, now() + make_interval(hours => $4::int), now() + make_interval(hours => $5::int), 100, 0)`,
        [listing.id, renter.userId, status, a, b]);
      await ins("CONFIRMED", 10, 15);
      await expect(ins("PENDING_PAYMENT", 12, 20)).rejects.toMatchObject({ code: "23P01" });
      await expect(ins("ACTIVE", 14, 16)).rejects.toMatchObject({ code: "23P01" });
      await ins("CANCELLED", 12, 20); // not a holding state: allowed to overlap
      await ins("EXPIRED", 12, 20);
      await ins("CONFIRMED", 15, 18); // adjacent
    });

    it("database CHECKs refuse a too-short rental and negative money", async () => {
      const { renter, listing } = await setup();
      const ins = (mins: number, total: number, deposit: number) => pool.query(
        `INSERT INTO rental_bookings (rental_listing_id, renter_id, start_at, end_at, total_amount, deposit_amount)
         VALUES ($1, $2, now() + interval '5 days', now() + interval '5 days' + make_interval(mins => $3::int), $4, $5)`,
        [listing.id, renter.userId, mins, total, deposit]);
      await expect(ins(30, 100, 0)).rejects.toMatchObject({ code: "23514" });
      await expect(ins(120, 0, 0)).rejects.toMatchObject({ code: "23514" });
      await expect(ins(120, 100, -1)).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("idempotency", () => {
    it("replaying the same request returns the same booking (200), not a second hold", async () => {
      const { renter, listing } = await setup();
      const key = idemKey();
      const s = hoursFromNow(48), e = hoursFromNow(53);
      const first = await book(app, renter, listing.id, s, e, key);
      const second = await book(app, renter, listing.id, s, e, key);
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.data.booking.id).toBe(first.body.data.booking.id);
      expect((await pool.query(`SELECT count(*)::int n FROM rental_bookings`)).rows[0].n).toBe(1);
    });

    it("the same key for different dates or another listing is a 409; keys are namespaced per renter", async () => {
      const { owner, renter, listing } = await setup();
      const l2 = await createRentalListing(app, owner, vt);
      const other = await registerRenter(app);
      const key = idemKey();
      await book(app, renter, listing.id, hoursFromNow(48), hoursFromNow(53), key);
      expect((await book(app, renter, listing.id, hoursFromNow(60), hoursFromNow(65), key)).status).toBe(409);
      expect((await book(app, renter, l2.id, hoursFromNow(48), hoursFromNow(53), key)).status).toBe(409);
      expect((await book(app, other, l2.id, hoursFromNow(48), hoursFromNow(53), key)).status).toBe(201); // same raw key, other renter
    });

    it("a replay after payment shows the booking as it is now", async () => {
      const { renter, listing } = await setup();
      const key = idemKey();
      const s = hoursFromNow(48), e = hoursFromNow(53);
      const b = (await book(app, renter, listing.id, s, e, key)).body.data.booking;
      await payBooking(app, renter, b.id);
      const replay = await book(app, renter, listing.id, s, e, key);
      expect(replay.status).toBe(200);
      expect(replay.body.data.booking.status).toBe("CONFIRMED");
    });
  });

  describe("paying", () => {
    it("charges rent + deposit, confirms the booking and records the confirmation time", async () => {
      const { renter, listing } = await setup();
      const b = await bookOk(app, renter, listing.id);
      const res = await payBooking(app, renter, b.id);
      expect(res.status).toBe(201);
      expect(res.body.data.payment).toMatchObject({ status: "SUCCESS", amount: 2500, payableType: "RENTAL" });
      const row = await bookingRow(b.id);
      expect(row.status).toBe("CONFIRMED");
      expect(row.confirmed_at).not.toBeNull();
    });

    it("a stranger gets 404; a second payment 409; a replayed key is idempotent", async () => {
      const { renter, listing } = await setup();
      const stranger = await registerRenter(app);
      const b = await bookOk(app, renter, listing.id);
      const key = idemKey();
      expect((await payBooking(app, stranger, b.id)).status).toBe(404);
      expect((await payBooking(app, renter, b.id, "tok_mock_success", key)).status).toBe(201);
      expect((await payBooking(app, renter, b.id)).status).toBe(409);
      expect((await payBooking(app, renter, b.id, "tok_mock_success", key)).status).toBe(201);
      expect((await pool.query(`SELECT count(*)::int n FROM payments WHERE payable_id = $1`, [b.id])).rows[0].n).toBe(1);
    });

    it("a declined card leaves the hold in place and a retry confirms it", async () => {
      const { renter, listing } = await setup();
      const b = await bookOk(app, renter, listing.id);
      expect((await payBooking(app, renter, b.id, "tok_mock_decline")).status).toBe(402);
      expect(await bookingStatus(b.id)).toBe("PENDING_PAYMENT");
      expect((await payBooking(app, renter, b.id)).status).toBe(201);
      expect(await bookingStatus(b.id)).toBe("CONFIRMED");
    });

    it("cannot pay a cancelled booking", async () => {
      const { renter, listing } = await setup();
      const b = await bookOk(app, renter, listing.id);
      await act(renter, b.id, "cancel");
      expect((await payBooking(app, renter, b.id)).status).toBe(409);
    });

    it("refuses a lapsed hold even if the expiry job never ran: 409, booking EXPIRED, nothing charged, dates free", async () => {
      const { renter, listing } = await setup();
      const other = await registerRenter(app);
      const b = await bookOk(app, renter, listing.id);
      await lapseHold(b.id, 60_000);

      expect((await payBooking(app, renter, b.id)).status).toBe(409);
      expect(await bookingStatus(b.id)).toBe("EXPIRED");
      expect(await payment(b.id)).toBeUndefined();
      expect((await book(app, other, listing.id, hoursFromNow(48), hoursFromNow(53))).status).toBe(201);
    });
  });

  describe("hold expiry", () => {
    it("expires an overdue hold; not-due is a no-op; running twice is harmless", async () => {
      const { renter, listing } = await setup();
      const b = await bookOk(app, renter, listing.id);
      await rentalBookingsService.expireIfDue(b.id);
      expect(await bookingStatus(b.id)).toBe("PENDING_PAYMENT");

      await lapseHold(b.id, 1000);
      await rentalBookingsService.expireIfDue(b.id);
      await rentalBookingsService.expireIfDue(b.id);
      const row = await bookingRow(b.id);
      expect(row.status).toBe("EXPIRED");
      expect(row.cancelled_by).toBe("SYSTEM");
    });

    it("tolerates a job firing slightly early (grace) but not far too early", async () => {
      const { renter, listing } = await setup();
      const b = await bookOk(app, renter, listing.id);
      await pool.query(`UPDATE rental_bookings SET payment_due_at = now() + interval '60 seconds' WHERE id = $1`, [b.id]);
      await rentalBookingsService.expireIfDue(b.id);
      expect(await bookingStatus(b.id)).toBe("PENDING_PAYMENT");
      await pool.query(`UPDATE rental_bookings SET payment_due_at = now() + interval '2 seconds' WHERE id = $1`, [b.id]);
      await rentalBookingsService.expireIfDue(b.id);
      expect(await bookingStatus(b.id)).toBe("EXPIRED");
    });

    it("never expires a hold whose payment is in flight (PROCESSING)", async () => {
      const { renter, listing } = await setup();
      const b = await bookOk(app, renter, listing.id);
      expect((await payBooking(app, renter, b.id, "tok_mock_error")).status).toBe(502);
      await lapseHold(b.id, 1000);
      await rentalBookingsService.expireIfDue(b.id);
      expect(await bookingStatus(b.id)).toBe("PENDING_PAYMENT");
    });

    it("never touches a CONFIRMED booking", async () => {
      const { renter, listing } = await setup();
      const b = await confirmedBooking(app, renter, listing.id);
      await lapseHold(b.id, 60_000);
      await rentalBookingsService.expireIfDue(b.id);
      expect(await bookingStatus(b.id)).toBe("CONFIRMED");
    });

    it("the delayed job fires through a real worker", async () => {
      const { renter, listing } = await setup();
      const b = await bookOk(app, renter, listing.id);
      await lapseHold(b.id, 1000);
      const worker: Worker = startRentalWorker(2);
      try {
        await worker.waitUntilReady();
        await getRentalQueue().add("expire-booking", { bookingId: b.id }); // as if the delay had elapsed
        const deadline = Date.now() + 8000;
        while ((await bookingStatus(b.id)) !== "EXPIRED" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        expect(await bookingStatus(b.id)).toBe("EXPIRED");
      } finally {
        await worker.close();
      }
    });
  });

  describe("cancellation and refunds", () => {
    it("renter cancels an unpaid hold: nothing to refund, dates freed", async () => {
      const { renter, listing } = await setup();
      const b = await bookOk(app, renter, listing.id);
      const res = await act(renter, b.id, "cancel");
      expect(res.status).toBe(200);
      expect(res.body.data.booking).toMatchObject({ status: "CANCELLED", cancelledBy: "RENTER", refundAmount: 0 });
    });

    it("renter cancelling a CONFIRMED booking 24h+ ahead is refunded in full (rent + deposit)", async () => {
      const { renter, listing } = await setup();
      const b = await confirmedBooking(app, renter, listing.id, 48, 53);
      const res = await act(renter, b.id, "cancel");
      expect(res.body.data.booking).toMatchObject({ status: "CANCELLED", cancelledBy: "RENTER", refundAmount: 2500 });
      expect((await payment(b.id)).status).toBe("REFUNDED");
    });

    it("renter cancelling inside 24h forfeits the payment", async () => {
      const { renter, listing } = await setup();
      const b = await confirmedBooking(app, renter, listing.id, 48, 53);
      await moveWindow(b.id, 600, 900); // starts in 10 hours
      const res = await act(renter, b.id, "cancel");
      expect(res.body.data.booking).toMatchObject({ status: "CANCELLED", refundAmount: 0 });
      expect((await payment(b.id)).status).toBe("SUCCESS");
    });

    it("the owner cancelling is always a full refund, even at the last minute", async () => {
      const { owner, renter, listing } = await setup();
      const b = await confirmedBooking(app, renter, listing.id, 48, 53);
      await moveWindow(b.id, 60, 360);
      const res = await act(owner, b.id, "cancel");
      expect(res.body.data.booking).toMatchObject({ status: "CANCELLED", cancelledBy: "OWNER", refundAmount: 2500 });
      expect((await payment(b.id)).status).toBe("REFUNDED");
    });

    it("cancelling again does not refund twice", async () => {
      const { renter, listing } = await setup();
      const b = await confirmedBooking(app, renter, listing.id);
      await act(renter, b.id, "cancel");
      expect((await act(renter, b.id, "cancel")).status).toBe(200);
      expect((await pool.query(`SELECT count(*)::int n FROM payments WHERE payable_id = $1`, [b.id])).rows[0].n).toBe(1);
      expect((await payment(b.id)).status).toBe("REFUNDED");
    });

    it("a refund that failed the first time is completed by cancelling again", async () => {
      const { renter, listing } = await setup();
      const b = await confirmedBooking(app, renter, listing.id);
      // State left behind by a crash between "mark cancelled" and "refund the payment".
      await pool.query(`UPDATE rental_bookings SET status = 'CANCELLED', cancelled_by = 'RENTER', cancelled_at = now(), refund_amount = 2500 WHERE id = $1`, [b.id]);
      expect((await payment(b.id)).status).toBe("SUCCESS");
      expect((await act(renter, b.id, "cancel")).status).toBe(200);
      expect((await payment(b.id)).status).toBe("REFUNDED");
    });

    it("only the renter or the owner may cancel; anyone else gets 404; a cancelled-without-refund booking cannot be cancelled again", async () => {
      const { renter, listing } = await setup();
      const stranger = await registerRenter(app);
      const b = await bookOk(app, renter, listing.id);
      expect((await act(stranger, b.id, "cancel")).status).toBe(404);
      await act(renter, b.id, "cancel");
      expect((await act(renter, b.id, "cancel")).status).toBe(409);
    });

    it("cannot cancel a booking while its payment is in flight", async () => {
      const { renter, listing } = await setup();
      const b = await bookOk(app, renter, listing.id);
      await payBooking(app, renter, b.id, "tok_mock_error"); // 502, payment left PROCESSING
      expect((await act(renter, b.id, "cancel")).status).toBe(409);
      expect(await bookingStatus(b.id)).toBe("PENDING_PAYMENT");
    });

    it("a payment that lands on an already-dead booking is refunded automatically", async () => {
      const { renter, listing } = await setup();
      const b = await confirmedBooking(app, renter, listing.id);
      await pool.query(`UPDATE rental_bookings SET status = 'EXPIRED' WHERE id = $1`, [b.id]); // as if the lock had expired mid-payment
      await rentalBookingsService.confirmAfterPayment(b.id);
      expect(await bookingStatus(b.id)).toBe("EXPIRED"); // not resurrected
      expect((await payment(b.id)).status).toBe("REFUNDED");
    });
  });

  describe("handover (start)", () => {
    it("starts a confirmed rental: booking ACTIVE and the vehicle RENTED", async () => {
      const { owner, renter, listing } = await setup();
      const b = await confirmedBooking(app, renter, listing.id);
      await moveWindow(b.id, -10, 290);
      const res = await act(owner, b.id, "start");
      expect(res.status).toBe(200);
      expect(res.body.data.booking.status).toBe("ACTIVE");
      expect(res.body.data.booking.startedAt).not.toBeNull();
      expect(await vehicleStatus(listing.vehicleId)).toBe("RENTED");
    });

    it("allows handover up to 30 minutes early but not earlier, and not after the period ended", async () => {
      const { owner, renter, listing } = await setup();
      const b = await confirmedBooking(app, renter, listing.id);
      await moveWindow(b.id, 120, 420);
      expect((await act(owner, b.id, "start")).status).toBe(400);
      await moveWindow(b.id, 20, 320);
      expect((await act(owner, b.id, "start")).status).toBe(200);

      const b2 = await confirmedBooking(app, renter, (await createRentalListing(app, owner, vt)).id);
      await moveWindow(b2.id, -400, -10);
      expect((await act(owner, b2.id, "start")).status).toBe(409);
    });

    it("needs a CONFIRMED booking: not unpaid, not twice", async () => {
      const { owner, renter, listing } = await setup();
      const unpaid = await bookOk(app, renter, listing.id, 48, 53);
      await moveWindow(unpaid.id, -10, 290);
      expect((await act(owner, unpaid.id, "start")).status).toBe(409);
      await act(renter, unpaid.id, "cancel");

      const b = await confirmedBooking(app, renter, listing.id);
      await moveWindow(b.id, -10, 290);
      expect((await act(owner, b.id, "start")).status).toBe(200);
      expect((await act(owner, b.id, "start")).status).toBe(409);
    });

    it("refuses while the vehicle is busy elsewhere (ride service / maintenance) and leaves the booking CONFIRMED", async () => {
      const { owner, renter, listing } = await setup();
      const b = await confirmedBooking(app, renter, listing.id);
      await moveWindow(b.id, -10, 290);
      for (const busy of ["IN_RIDE_SERVICE", "UNDER_MAINTENANCE"]) {
        await pool.query(`UPDATE vehicles SET status = $2::vehicle_status WHERE id = $1`, [listing.vehicleId, busy]);
        expect((await act(owner, b.id, "start")).status).toBe(409);
        expect(await bookingStatus(b.id)).toBe("CONFIRMED");
        expect(await vehicleStatus(listing.vehicleId)).toBe(busy);
      }
      await pool.query(`UPDATE vehicles SET status = 'AVAILABLE' WHERE id = $1`, [listing.vehicleId]);
      expect((await act(owner, b.id, "start")).status).toBe(200);
    });

    it("only the listing's owner can start (others 404; renters hit the role check)", async () => {
      const { renter, listing } = await setup();
      const otherOwner = await registerOwner(app);
      const b = await confirmedBooking(app, renter, listing.id);
      await moveWindow(b.id, -10, 290);
      expect((await act(otherOwner, b.id, "start")).status).toBe(404);
      expect((await act(renter, b.id, "start")).status).toBe(403);
    });

    it("an active rental cannot be cancelled", async () => {
      const { owner, renter, listing } = await setup();
      const b = await confirmedBooking(app, renter, listing.id);
      await moveWindow(b.id, -10, 290);
      await act(owner, b.id, "start");
      expect((await act(renter, b.id, "cancel")).status).toBe(409);
      expect((await act(owner, b.id, "cancel")).status).toBe(409);
    });
  });

  describe("return (complete)", () => {
    async function activeBooking() {
      const s = await setup();
      const b = await confirmedBooking(app, s.renter, s.listing.id);
      await moveWindow(b.id, -10, 290);
      await act(s.owner, b.id, "start");
      return { ...s, b };
    }

    it("an on-time return: no late fee, whole deposit comes back, vehicle AVAILABLE again", async () => {
      const { owner, listing, b } = await activeBooking();
      const res = await act(owner, b.id, "complete");
      expect(res.status).toBe(200);
      expect(res.body.data.booking).toMatchObject({ status: "COMPLETED", lateFee: 0, damageDeduction: 0, depositRefundDue: 2000 });
      expect(res.body.data.booking.actualReturnAt).not.toBeNull();
      expect(await vehicleStatus(listing.vehicleId)).toBe("AVAILABLE");
    });

    it("a return inside the 15-minute grace is not charged", async () => {
      const { owner, b } = await activeBooking();
      await moveWindow(b.id, -300, -10);
      expect((await act(owner, b.id, "complete")).body.data.booking.lateFee).toBe(0);
    });

    it("a late return is charged whole late hours x hourly rate x 1.5, taken from the deposit", async () => {
      const { owner, b } = await activeBooking();
      await moveWindow(b.id, -600, -150); // 2.5h late -> 3 billed hours
      const res = await act(owner, b.id, "complete");
      expect(res.body.data.booking).toMatchObject({ lateFee: 450, depositRefundDue: 1550 });
    });

    it("uses the hourly rate the renter booked at, not today's", async () => {
      const { owner, listing, b } = await activeBooking();
      await request(app).patch(`/api/rentals/listings/${listing.id}`).set(bearer(owner.accessToken)).send({ hourlyPrice: 5000 });
      await moveWindow(b.id, -600, -150);
      expect((await act(owner, b.id, "complete")).body.data.booking.lateFee).toBe(450);
    });

    it("an owner's damage claim is deducted too, and the total can never exceed the deposit", async () => {
      const { owner, b } = await activeBooking();
      await moveWindow(b.id, -600, -150);
      const res = await act(owner, b.id, "complete", { damageDeduction: 500, notes: "Scratch on the left door" });
      expect(res.body.data.booking).toMatchObject({ lateFee: 450, damageDeduction: 500, depositRefundDue: 1050, returnNotes: "Scratch on the left door" });
    });

    it("a huge late fee still leaves the refund at zero, never negative", async () => {
      const { owner, b } = await activeBooking();
      await moveWindow(b.id, -2500, -1790); // just under 30h late -> 30 billed hours: 30 x 100 x 1.5 = 4500
      const res = await act(owner, b.id, "complete");
      expect(res.body.data.booking).toMatchObject({ lateFee: 4500, depositRefundDue: 0 });
    });

    it("rejects a damage claim above the deposit, unknown fields, and completing twice or before handover", async () => {
      const { owner, renter, listing, b } = await activeBooking();
      expect((await act(owner, b.id, "complete", { damageDeduction: 2001 })).status).toBe(400);
      expect((await act(owner, b.id, "complete", { depositRefundDue: 2000 })).status).toBe(400);
      expect((await act(owner, b.id, "complete")).status).toBe(200);
      expect((await act(owner, b.id, "complete")).status).toBe(409);

      const l2 = await createRentalListing(app, owner, vt);
      const early = await confirmedBooking(app, renter, l2.id);
      expect((await act(owner, early.id, "complete")).status).toBe(409); // never handed over
    });

    it("only the owner can complete", async () => {
      const { renter, b } = await activeBooking();
      const stranger = await registerOwner(app);
      expect((await act(stranger, b.id, "complete")).status).toBe(404);
      expect((await act(renter, b.id, "complete")).status).toBe(403);
    });
  });

  describe("reading bookings", () => {
    it("renter, owner and admin can read a booking; anyone else gets 404", async () => {
      const { owner, renter, listing } = await setup();
      const admin = await makeAdmin(app);
      const stranger = await registerRenter(app);
      const otherOwner = await registerOwner(app);
      const b = await bookOk(app, renter, listing.id);
      const get = (t: { accessToken: string }) => request(app).get(`/api/rentals/bookings/${b.id}`).set(bearer(t.accessToken));
      for (const u of [renter, owner, admin]) expect((await get(u)).status).toBe(200);
      expect((await get(stranger)).status).toBe(404);
      expect((await get(otherOwner)).status).toBe(404);
      expect((await request(app).get(`/api/rentals/bookings/${b.id}`)).status).toBe(401);
    });

    it("lists my bookings (renter), incoming bookings (owner, optionally per listing) and a listing's bookings", async () => {
      const { owner, renter, listing } = await setup();
      const l2 = await createRentalListing(app, owner, vt);
      const stranger = await registerRenter(app);
      const otherOwner = await registerOwner(app);
      await bookOk(app, renter, listing.id, 48, 53);
      await bookOk(app, renter, l2.id, 48, 53);

      expect((await request(app).get("/api/rentals/bookings/mine").set(bearer(renter.accessToken))).body.data.bookings).toHaveLength(2);
      expect((await request(app).get("/api/rentals/bookings/mine").set(bearer(stranger.accessToken))).body.data.bookings).toHaveLength(0);
      expect((await request(app).get("/api/rentals/bookings/incoming").set(bearer(owner.accessToken))).body.data.bookings).toHaveLength(2);
      expect((await request(app).get(`/api/rentals/bookings/incoming?listingId=${l2.id}`).set(bearer(owner.accessToken))).body.data.bookings).toHaveLength(1);
      expect((await request(app).get(`/api/rentals/listings/${listing.id}/bookings`).set(bearer(owner.accessToken))).body.data.bookings).toHaveLength(1);
      expect((await request(app).get(`/api/rentals/listings/${listing.id}/bookings`).set(bearer(otherOwner.accessToken))).status).toBe(404);
      expect((await request(app).get("/api/rentals/bookings/incoming").set(bearer(otherOwner.accessToken))).body.data.bookings).toHaveLength(0);
    });
  });
});

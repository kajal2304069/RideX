import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";
import { rentalBookingsService } from "../../src/modules/rentals/services/rentalBookings.service";
import {
  bearer, book, bookOk, bookingStatus, confirmedBooking, createRentalListing, ensureRentalVehicleType, hoursFromNow, idemKey, moveWindow,
  payBooking, registerOwner, registerRenter, resetRentalTables, vehicleStatus,
} from "./rentalFixtures";

const app = createApp();
let vt: string;
const count = (rs: { status: number }[], s: number) => rs.filter((r) => r.status === s).length;
const act = (t: { accessToken: string }, id: string, action: string) =>
  request(app).post(`/api/rentals/bookings/${id}/${action}`).set(bearer(t.accessToken)).send({});
const paymentStatuses = async (bookingId: string) =>
  (await pool.query(`SELECT status FROM payments WHERE payable_type = 'RENTAL' AND payable_id = $1`, [bookingId])).rows.map((r) => r.status as string);

describe("Rental concurrency (live DB + Redis)", () => {
  beforeAll(async () => { vt = await ensureRentalVehicleType("RNT_CONC_BOTH", "BOTH"); });
  beforeEach(async () => { await resetRentalTables(); await redis.flushdb(); });
  afterAll(async () => { await closeTestDb(); redis.disconnect(); });

  it("8 renters booking the same dates at once: exactly one 201, seven 409, one holding row", async () => {
    const owner = await registerOwner(app);
    const listing = await createRentalListing(app, owner, vt);
    const renters = await Promise.all(Array.from({ length: 8 }, () => registerRenter(app)));
    const base = Date.now();
    const rs = await Promise.all(renters.map((r) => book(app, r, listing.id, new Date(base + 48 * 3_600_000), new Date(base + 53 * 3_600_000))));
    expect(count(rs, 201)).toBe(1);
    expect(count(rs, 409)).toBe(7);
    expect((await pool.query(`SELECT count(*)::int n FROM rental_bookings WHERE rental_listing_id = $1`, [listing.id])).rows[0].n).toBe(1);
  });

  it("the same renter sending the identical request 8 times at once creates one booking and no errors", async () => {
    const owner = await registerOwner(app);
    const renter = await registerRenter(app);
    const listing = await createRentalListing(app, owner, vt);
    const key = idemKey();
    const s = hoursFromNow(48), e = hoursFromNow(53);
    const rs = await Promise.all(Array.from({ length: 8 }, () => book(app, renter, listing.id, s, e, key)));
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(count(rs, 201)).toBe(1);
    expect(new Set(rs.map((r) => r.body.data.booking.id)).size).toBe(1);
    expect((await pool.query(`SELECT count(*)::int n FROM rental_bookings`)).rows[0].n).toBe(1);
  });

  it("partially overlapping windows racing each other never leave two overlapping holds", async () => {
    const owner = await registerOwner(app);
    const listing = await createRentalListing(app, owner, vt);
    const renters = await Promise.all(Array.from({ length: 10 }, () => registerRenter(app)));
    const base = Date.now();
    // Window i covers [48 + 2i, 48 + 2i + 5): each overlaps its neighbours.
    const rs = await Promise.all(renters.map((r, i) =>
      book(app, r, listing.id, new Date(base + (48 + 2 * i) * 3_600_000), new Date(base + (53 + 2 * i) * 3_600_000))));
    expect(rs.every((r) => [201, 409].includes(r.status))).toBe(true);
    expect(count(rs, 201)).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM rental_bookings a JOIN rental_bookings b
         ON a.rental_listing_id = b.rental_listing_id AND a.id < b.id
        AND tstzrange(a.start_at, a.end_at, '[)') && tstzrange(b.start_at, b.end_at, '[)')
       WHERE a.status IN ('PENDING_PAYMENT','CONFIRMED','ACTIVE') AND b.status IN ('PENDING_PAYMENT','CONFIRMED','ACTIVE')`);
    expect(rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM rental_bookings`)).rows[0].n).toBe(count(rs, 201));
  });

  it("10 simultaneous payments with different keys: one payment, booking CONFIRMED once", async () => {
    const owner = await registerOwner(app);
    const renter = await registerRenter(app);
    const listing = await createRentalListing(app, owner, vt);
    const b = await bookOk(app, renter, listing.id);
    const rs = await Promise.all(Array.from({ length: 10 }, () => payBooking(app, renter, b.id)));
    expect(count(rs, 201)).toBe(1);
    expect(count(rs, 409)).toBe(9);
    expect(await paymentStatuses(b.id)).toEqual(["SUCCESS"]);
    expect(await bookingStatus(b.id)).toBe("CONFIRMED");
  });

  it("payment vs expiry race inside the grace window never yields a paid-but-expired booking", async () => {
    for (let round = 0; round < 6; round++) {
      const owner = await registerOwner(app);
      const renter = await registerRenter(app);
      const listing = await createRentalListing(app, owner, vt);
      const b = await bookOk(app, renter, listing.id);
      await pool.query(`UPDATE rental_bookings SET payment_due_at = now() + interval '2 seconds' WHERE id = $1`, [b.id]); // timer WOULD expire it if it won

      await Promise.all([payBooking(app, renter, b.id), rentalBookingsService.expireIfDue(b.id)]);

      const status = await bookingStatus(b.id);
      const payments = await paymentStatuses(b.id);
      if (payments.includes("SUCCESS")) expect(status).toBe("CONFIRMED");
      else { expect(status).toBe("EXPIRED"); expect(payments).toEqual([]); }
    }
  });

  it("payment vs cancel race ends consistent: confirmed+paid, or cancelled with no money left in", async () => {
    for (let round = 0; round < 6; round++) {
      const owner = await registerOwner(app);
      const renter = await registerRenter(app);
      const listing = await createRentalListing(app, owner, vt);
      const b = await bookOk(app, renter, listing.id, 48, 53); // far enough ahead that a cancel after payment is a full refund

      await Promise.all([payBooking(app, renter, b.id), act(renter, b.id, "cancel")]);

      const status = await bookingStatus(b.id);
      const payments = await paymentStatuses(b.id);
      if (status === "CONFIRMED") expect(payments).toEqual(["SUCCESS"]);
      else {
        expect(status).toBe("CANCELLED");
        expect(payments.every((p) => p === "REFUNDED")).toBe(true); // never SUCCESS (paid, cancelled, not refunded)
      }
    }
  });

  it("handover vs cancel on a confirmed booking: exactly one wins, and the vehicle state matches", async () => {
    for (let round = 0; round < 6; round++) {
      const owner = await registerOwner(app);
      const renter = await registerRenter(app);
      const listing = await createRentalListing(app, owner, vt);
      const b = await confirmedBooking(app, renter, listing.id);
      await moveWindow(b.id, -10, 290);

      const [start, cancel] = await Promise.all([act(owner, b.id, "start"), act(renter, b.id, "cancel")]);

      expect([start.status, cancel.status].filter((s) => s === 200)).toHaveLength(1);
      if (start.status === 200) {
        expect(await bookingStatus(b.id)).toBe("ACTIVE");
        expect(await vehicleStatus(listing.vehicleId)).toBe("RENTED");
      } else {
        expect(await bookingStatus(b.id)).toBe("CANCELLED");
        expect(await vehicleStatus(listing.vehicleId)).toBe("AVAILABLE");
      }
    }
  });

  it("two simultaneous handovers: one 200, one 409; two simultaneous returns: one 200, one 409", async () => {
    const owner = await registerOwner(app);
    const renter = await registerRenter(app);
    const listing = await createRentalListing(app, owner, vt);
    const b = await confirmedBooking(app, renter, listing.id);
    await moveWindow(b.id, -10, 290);

    const starts = await Promise.all([act(owner, b.id, "start"), act(owner, b.id, "start"), act(owner, b.id, "start")]);
    expect(count(starts, 200)).toBe(1);
    expect(count(starts, 409)).toBe(2);

    const completes = await Promise.all([act(owner, b.id, "complete"), act(owner, b.id, "complete"), act(owner, b.id, "complete")]);
    expect(count(completes, 200)).toBe(1);
    expect(count(completes, 409)).toBe(2);
    expect(await vehicleStatus(listing.vehicleId)).toBe("AVAILABLE");
  });

  it("back-to-back confirmed bookings: the next one cannot be handed over until the vehicle is back", async () => {
    const owner = await registerOwner(app);
    const r1 = await registerRenter(app);
    const r2 = await registerRenter(app);
    const listing = await createRentalListing(app, owner, vt);
    const base = Date.now();
    const at = (h: number) => new Date(base + h * 3_600_000);
    const b1 = (await book(app, r1, listing.id, at(48), at(53))).body.data.booking;
    const b2 = (await book(app, r2, listing.id, at(53), at(58))).body.data.booking;
    await payBooking(app, r1, b1.id);
    await payBooking(app, r2, b2.id);
    // b1 is due now and ends in 10 minutes; b2 begins right after it, so it is also within the early-handover window.
    await moveWindow(b1.id, -250, 10);
    await moveWindow(b2.id, 11, 311);

    expect((await act(owner, b1.id, "start")).status).toBe(200);
    expect((await act(owner, b2.id, "start")).status).toBe(409); // vehicle is RENTED
    expect(await bookingStatus(b2.id)).toBe("CONFIRMED");
    await act(owner, b1.id, "complete");
    expect((await act(owner, b2.id, "start")).status).toBe(200);
  });
});

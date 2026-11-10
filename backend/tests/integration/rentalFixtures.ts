import request from "supertest";
import { Application } from "express";
import { pool } from "../../src/db/pool";
import { idemKey, registerUser } from "./paymentFixtures";
import { CENTER, bearer } from "./garageFixtures";

export { bearer, idemKey, CENTER };
export { resetGarageTables as resetRentalTables } from "./garageFixtures";

export type Account = { userId: string; accessToken: string; email: string };

export const registerOwner = (app: Application) => registerUser(app, ["VEHICLE_OWNER"]);
export const registerRenter = (app: Application) => registerUser(app, ["RIDER"]);

export async function ensureRentalVehicleType(code: string, category = "BOTH"): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO vehicle_types (code, display_name, base_fare, per_km_rate, per_min_rate, category)
     VALUES ($1, 'Rental Test Type', 50, 13, 1.5, $2)
     ON CONFLICT (code) DO UPDATE SET category = EXCLUDED.category RETURNING id`,
    [code, category]
  );
  return rows[0].id;
}

export async function createOwnerVehicle(app: Application, owner: Account, vehicleTypeId: string, over: Record<string, unknown> = {}) {
  const res = await request(app).post("/api/vehicles").set(bearer(owner.accessToken)).send({
    vehicleTypeId, registrationNumber: `KA-RNT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    brand: "Hyundai", model: "Creta", year: 2022, ...over,
  });
  if (res.status !== 201) throw new Error(`createOwnerVehicle failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.vehicle.id as string;
}

export function listingBody(vehicleId: string, over: Record<string, unknown> = {}) {
  return { vehicleId, hourlyPrice: 100, dailyPrice: 800, securityDeposit: 2000, lat: CENTER.lat, lng: CENTER.lng, address: "MG Road, Bangalore", rules: "No smoking", ...over };
}

/** A vehicle owned by `owner` and a rental listing for it. */
export async function createRentalListing(app: Application, owner: Account, vehicleTypeId: string, over: Record<string, unknown> = {}, vehicleOver: Record<string, unknown> = {}) {
  const vehicleId = await createOwnerVehicle(app, owner, vehicleTypeId, vehicleOver);
  const res = await request(app).post("/api/rentals/listings").set(bearer(owner.accessToken)).send(listingBody(vehicleId, over));
  if (res.status !== 201) throw new Error(`createRentalListing failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...(res.body.data.listing as { id: string }), vehicleId };
}

export const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);
export const iso = (d: Date) => d.toISOString();

export function book(app: Application, renter: Account, listingId: string, start: Date, end: Date, key = idemKey()) {
  return request(app).post(`/api/rentals/listings/${listingId}/bookings`).set(bearer(renter.accessToken))
    .send({ startAt: start.toISOString(), endAt: end.toISOString(), idempotencyKey: key });
}

/** Books [startH, endH] hours from now and returns the booking; throws if the booking is refused. */
export async function bookOk(app: Application, renter: Account, listingId: string, startH = 48, endH = 53) {
  const res = await book(app, renter, listingId, hoursFromNow(startH), hoursFromNow(endH));
  if (res.status !== 201) throw new Error(`book failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.booking as { id: string; rentAmount: number; depositAmount: number; totalDue: number; status: string };
}

export function payBooking(app: Application, renter: Account, bookingId: string, token = "tok_mock_success", key = idemKey()) {
  return request(app).post("/api/payments").set(bearer(renter.accessToken)).set("Idempotency-Key", key)
    .send({ payableType: "RENTAL", payableId: bookingId, paymentMethodToken: token });
}

/** Books and pays: the booking is CONFIRMED. */
export async function confirmedBooking(app: Application, renter: Account, listingId: string, startH = 48, endH = 53) {
  const b = await bookOk(app, renter, listingId, startH, endH);
  const res = await payBooking(app, renter, b.id);
  if (res.status !== 201) throw new Error(`pay failed: ${res.status} ${JSON.stringify(res.body)}`);
  return b;
}

export const bookingRow = async (id: string) => (await pool.query(`SELECT * FROM rental_bookings WHERE id = $1`, [id])).rows[0];
export const bookingStatus = async (id: string) => (await bookingRow(id)).status as string;
export const vehicleStatus = async (id: string) => (await pool.query(`SELECT status FROM vehicles WHERE id = $1`, [id])).rows[0].status as string;

/** Pretends the payment deadline passed `ms` ago. */
export const lapseHold = (bookingId: string, ms: number) =>
  pool.query(`UPDATE rental_bookings SET payment_due_at = now() - make_interval(secs => $2::float8) WHERE id = $1`, [bookingId, ms / 1000]);

/** Time-travel for handover/return tests: moves the booked window to [now + startMin, now + endMin] (minutes, may be negative). */
export const moveWindow = (bookingId: string, startOffsetMin: number, endOffsetMin: number) =>
  pool.query(
    `UPDATE rental_bookings SET start_at = now() + make_interval(mins => $2::int), end_at = now() + make_interval(mins => $3::int) WHERE id = $1`,
    [bookingId, startOffsetMin, endOffsetMin]
  );

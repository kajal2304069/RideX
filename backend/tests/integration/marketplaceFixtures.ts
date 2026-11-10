import request from "supertest";
import { Application } from "express";
import { pool } from "../../src/db/pool";
import { registerUser } from "./paymentFixtures";
import { bearer } from "./garageFixtures";

export { bearer };
export { resetGarageTables as resetMarketplaceTables } from "./garageFixtures";

export type Account = { userId: string; accessToken: string; email: string };

export const registerSeller = (app: Application) => registerUser(app, ["SELLER"]);
export const registerBuyer = (app: Application) => registerUser(app, ["BUYER"]);
export const registerMechanic = (app: Application) => registerUser(app, ["MECHANIC"]);

export function listingPayload(vehicleTypeId: string, over: Record<string, unknown> = {}) {
  return {
    vehicleTypeId, brand: "Honda", model: "City", year: 2019, mileageKm: 42000, fuelType: "PETROL", transmission: "MANUAL",
    condition: "GOOD", ownerCount: 1, price: 500000, lat: 12.9716, lng: 77.5946, address: "Indiranagar, Bangalore",
    description: "Well maintained", ...over,
  };
}

export async function createListing(app: Application, seller: Account, vehicleTypeId: string, over: Record<string, unknown> = {}) {
  const res = await request(app).post("/api/marketplace/listings").set(bearer(seller.accessToken)).send(listingPayload(vehicleTypeId, over));
  if (res.status !== 201) throw new Error(`createListing failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.listing as { id: string; price: number };
}

export async function makeOffer(app: Application, buyer: Account, listingId: string, amount: number) {
  return request(app).post(`/api/marketplace/listings/${listingId}/offers`).set(bearer(buyer.accessToken)).send({ amount });
}

export async function acceptOffer(app: Application, seller: Account, offerId: string) {
  return request(app).post(`/api/marketplace/offers/${offerId}/accept`).set(bearer(seller.accessToken));
}

/** Pretend `ms` of wall-clock time has passed since the offer was accepted. */
export async function ageAcceptedOffer(offerId: string, ms: number) {
  await pool.query(`UPDATE vehicle_offers SET accepted_at = now() - make_interval(secs => $2::float8) WHERE id = $1`, [offerId, ms / 1000]);
}

export const goodReport = {
  engine: { score: 8 }, brakes: { score: 7 }, tyres: { score: 9 }, battery: { score: 6 }, body: { score: 8 }, electrical: { score: 8 },
  documents: { verified: true }, accidentHistory: { hadAccident: false },
};

export const futureDate = (hours = 48) => new Date(Date.now() + hours * 3_600_000).toISOString();

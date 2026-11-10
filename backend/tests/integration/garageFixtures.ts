import request from "supertest";
import { Application } from "express";
import { pool } from "../../src/db/pool";
import { registerUser } from "./paymentFixtures";

export const CENTER = { lat: 12.9716, lng: 77.5946 };
/** ~111 m per 0.001 degree of latitude. */
export const offsetMeters = (m: number) => ({ lat: CENTER.lat + m / 111_000, lng: CENTER.lng });

export async function resetGarageTables() {
  // CASCADE from users clears everything that references it; vehicle_types is untouched.
  await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

export async function createGarage(
  app: Application,
  owner: { accessToken: string },
  opts: { name?: string; at?: { lat: number; lng: number }; services?: string[]; mechanics?: string[] } = {}
) {
  const at = opts.at ?? CENTER;
  const res = await request(app)
    .post("/api/garages")
    .set(bearer(owner.accessToken))
    .send({ name: opts.name ?? "Test Garage", lat: at.lat, lng: at.lng, address: "1 Workshop Road", phone: "9999999999" });
  if (res.status !== 201) throw new Error(`createGarage failed: ${res.status} ${JSON.stringify(res.body)}`);
  const garageId = res.body.data.garage.id as string;

  const services: Record<string, string> = {};
  for (const type of opts.services ?? ["OIL_CHANGE"]) {
    const s = await request(app)
      .post(`/api/garages/${garageId}/services`)
      .set(bearer(owner.accessToken))
      .send({ serviceType: type, priceFrom: 500, priceTo: 2000, estimatedDurationMinutes: 60 });
    services[type] = s.body.data.service.id;
  }

  const mechanicIds: string[] = [];
  for (const name of opts.mechanics ?? ["Ravi"]) {
    const m = await request(app).post(`/api/garages/${garageId}/mechanics`).set(bearer(owner.accessToken)).send({ name, specialization: "General" });
    mechanicIds.push(m.body.data.mechanic.id);
  }
  return { garageId, services, mechanicIds };
}

export async function registerGarageOwner(app: Application) {
  return registerUser(app, ["GARAGE_OWNER"]);
}

/** A customer who also owns a registered vehicle (VEHICLE_OWNER), so they can attach it to a booking. */
export async function customerWithVehicle(app: Application, vehicleTypeId: string) {
  const customer = await registerUser(app, ["RIDER", "VEHICLE_OWNER"]);
  const v = await request(app)
    .post("/api/vehicles")
    .set(bearer(customer.accessToken))
    .send({ vehicleTypeId, registrationNumber: `KA-GAR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, brand: "Honda", model: "City", year: 2021 });
  if (v.status !== 201) throw new Error(`vehicle create failed: ${v.status} ${JSON.stringify(v.body)}`);
  return { ...customer, vehicleId: v.body.data.vehicle.id as string };
}

export const bookingKey = () => `book-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** Drives a booking to the requested point of the lifecycle through the real API. */
export async function advanceBooking(
  app: Application,
  owner: { accessToken: string },
  bookingId: string,
  mechanicId: string,
  upTo: "accept" | "assign" | "received" | "started" | "ready",
  costs = { laborCost: 500, partsUsed: [{ name: "Oil filter", quantity: 2, unitPrice: 250.5 }] }
) {
  const steps: Array<[string, () => request.Test]> = [
    ["accept", () => request(app).post(`/api/bookings/${bookingId}/accept`)],
    ["assign", () => request(app).post(`/api/bookings/${bookingId}/assign-mechanic`).send({ mechanicId })],
    ["received", () => request(app).post(`/api/bookings/${bookingId}/vehicle-received`)],
    ["started", () => request(app).post(`/api/bookings/${bookingId}/start-repair`)],
  ];
  const order = ["accept", "assign", "received", "started", "ready"];
  for (const [name, make] of steps) {
    if (order.indexOf(name) > order.indexOf(upTo)) break;
    const r = await make().set(bearer(owner.accessToken));
    if (r.status >= 400) throw new Error(`advance ${name} failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  if (upTo === "ready") {
    const put = await request(app).put(`/api/bookings/${bookingId}/repair-order`).set(bearer(owner.accessToken)).send(costs);
    if (put.status >= 400) throw new Error(`repair-order failed: ${put.status} ${JSON.stringify(put.body)}`);
    const r = await request(app).post(`/api/bookings/${bookingId}/ready`).set(bearer(owner.accessToken));
    if (r.status >= 400) throw new Error(`ready failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

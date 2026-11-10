import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";
import { makeAdmin, registerUser } from "./paymentFixtures";
import { offsetMeters } from "./garageFixtures";
import {
  bearer, book, bookOk, confirmedBooking, createOwnerVehicle, createRentalListing, ensureRentalVehicleType, hoursFromNow, lapseHold,
  listingBody, registerOwner, registerRenter, resetRentalTables,
} from "./rentalFixtures";

const app = createApp();
let vt: string;
let rideOnlyVt: string;

const search = (qs: string) => request(app).get(`/api/rentals/listings${qs ? `?${qs}` : ""}`);
const ids = (res: request.Response) => res.body.data.listings.map((l: { id: string }) => l.id) as string[];

describe("Rental listings, search, quote and availability (live DB)", () => {
  beforeAll(async () => {
    vt = await ensureRentalVehicleType("RNT_LIST_BOTH", "BOTH");
    rideOnlyVt = await ensureRentalVehicleType("RNT_LIST_RIDE", "RIDE");
  });
  beforeEach(async () => { await resetRentalTables(); await redis.flushdb(); });
  afterAll(async () => { await closeTestDb(); redis.disconnect(); });

  describe("creating a listing", () => {
    it("lets a vehicle owner list their own vehicle", async () => {
      const owner = await registerOwner(app);
      const vehicleId = await createOwnerVehicle(app, owner, vt);
      const res = await request(app).post("/api/rentals/listings").set(bearer(owner.accessToken)).send(listingBody(vehicleId));
      expect(res.status).toBe(201);
      expect(res.body.data.listing).toMatchObject({
        vehicleId, ownerId: owner.userId, hourlyPrice: 100, dailyPrice: 800, securityDeposit: 2000, isActive: true,
        brand: "Hyundai", model: "Creta", location: { address: "MG Road, Bangalore" },
      });
      expect(res.body.data.listing).not.toHaveProperty("registrationNumber");
    });

    it("accepts hourly-only or daily-only, but not neither", async () => {
      const owner = await registerOwner(app);
      const v1 = await createOwnerVehicle(app, owner, vt);
      const v2 = await createOwnerVehicle(app, owner, vt);
      const v3 = await createOwnerVehicle(app, owner, vt);
      const post = (body: object) => request(app).post("/api/rentals/listings").set(bearer(owner.accessToken)).send(body);
      expect((await post({ ...listingBody(v1), dailyPrice: undefined })).status).toBe(201);
      expect((await post({ ...listingBody(v2), hourlyPrice: undefined })).status).toBe(201);
      expect((await post({ ...listingBody(v3), hourlyPrice: undefined, dailyPrice: undefined })).status).toBe(400);
    });

    it("rejects bad numbers, unknown fields and the wrong role", async () => {
      const owner = await registerOwner(app);
      const renter = await registerRenter(app);
      const v = await createOwnerVehicle(app, owner, vt);
      const post = (t: string, body: object) => request(app).post("/api/rentals/listings").set(bearer(t)).send(body);
      expect((await post(owner.accessToken, listingBody(v, { hourlyPrice: 0 }))).status).toBe(400);
      expect((await post(owner.accessToken, listingBody(v, { dailyPrice: -5 }))).status).toBe(400);
      expect((await post(owner.accessToken, listingBody(v, { securityDeposit: -1 }))).status).toBe(400);
      expect((await post(owner.accessToken, listingBody(v, { lat: 91 }))).status).toBe(400);
      expect((await post(owner.accessToken, listingBody(v, { ownerId: "x" }))).status).toBe(400);
      expect((await post(renter.accessToken, listingBody(v))).status).toBe(403);
      expect((await request(app).post("/api/rentals/listings").send(listingBody(v))).status).toBe(401);
    });

    it("404s for a vehicle that is not yours or does not exist (never confirming it exists)", async () => {
      const owner = await registerOwner(app);
      const other = await registerOwner(app);
      const theirs = await createOwnerVehicle(app, other, vt);
      const post = (v: string) => request(app).post("/api/rentals/listings").set(bearer(owner.accessToken)).send(listingBody(v));
      expect((await post(theirs)).status).toBe(404);
      expect((await post("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    });

    it("refuses ride-only vehicle types and a second listing for the same vehicle", async () => {
      const owner = await registerOwner(app);
      const ride = await createOwnerVehicle(app, owner, rideOnlyVt);
      expect((await request(app).post("/api/rentals/listings").set(bearer(owner.accessToken)).send(listingBody(ride))).status).toBe(400);

      const l = await createRentalListing(app, owner, vt);
      expect((await request(app).post("/api/rentals/listings").set(bearer(owner.accessToken)).send(listingBody(l.vehicleId))).status).toBe(409);
    });

    it("the database itself refuses a listing by someone who does not own the vehicle", async () => {
      const owner = await registerOwner(app);
      const thief = await registerOwner(app);
      const v = await createOwnerVehicle(app, owner, vt);
      await expect(pool.query(
        `INSERT INTO rental_listings (owner_id, vehicle_id, daily_price, pickup_location) VALUES ($1, $2, 500, ST_SetSRID(ST_MakePoint(77.5, 12.9), 4326)::geography)`,
        [thief.userId, v]
      )).rejects.toMatchObject({ code: "23503" });
    });

    it("database CHECKs refuse a listing with no price or a non-positive price", async () => {
      const owner = await registerOwner(app);
      const v = await createOwnerVehicle(app, owner, vt);
      const insert = (h: number | null, d: number | null) => pool.query(
        `INSERT INTO rental_listings (owner_id, vehicle_id, hourly_price, daily_price, pickup_location)
         VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint(77.5, 12.9), 4326)::geography)`, [owner.userId, v, h, d]);
      await expect(insert(null, null)).rejects.toMatchObject({ code: "23514" });
      await expect(insert(0, null)).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("editing, hiding and visibility", () => {
    it("updates prices and details; others get 404; strict schema", async () => {
      const owner = await registerOwner(app);
      const other = await registerOwner(app);
      const l = await createRentalListing(app, owner, vt);
      const patch = (t: string, body: object) => request(app).patch(`/api/rentals/listings/${l.id}`).set(bearer(t)).send(body);

      const ok = await patch(owner.accessToken, { dailyPrice: 900, securityDeposit: 3000, rules: "Return with a full tank" });
      expect(ok.body.data.listing).toMatchObject({ dailyPrice: 900, securityDeposit: 3000, rules: "Return with a full tank", hourlyPrice: 100 });
      expect((await patch(other.accessToken, { dailyPrice: 1 })).status).toBe(404);
      expect((await patch(owner.accessToken, {})).status).toBe(400);
      expect((await patch(owner.accessToken, { vehicleId: "x" })).status).toBe(400);
      expect((await patch(owner.accessToken, { lat: 12.9 })).status).toBe(400);
      expect((await patch(owner.accessToken, { lat: 13.0, lng: 77.6 })).status).toBe(200);
    });

    it("can drop one price but never both", async () => {
      const owner = await registerOwner(app);
      const l = await createRentalListing(app, owner, vt);
      const patch = (body: object) => request(app).patch(`/api/rentals/listings/${l.id}`).set(bearer(owner.accessToken)).send(body);
      expect((await patch({ hourlyPrice: null })).body.data.listing.hourlyPrice).toBeNull();
      expect((await patch({ dailyPrice: null })).status).toBe(400);
    });

    it("an inactive listing disappears from search and the public, but stays visible to its owner and admins", async () => {
      const owner = await registerOwner(app);
      const l = await createRentalListing(app, owner, vt);
      const admin = await makeAdmin(app);
      expect((await request(app).post(`/api/rentals/listings/${l.id}/deactivate`).set(bearer(owner.accessToken))).body.data.listing.isActive).toBe(false);

      expect(ids(await search(""))).toEqual([]);
      expect((await request(app).get(`/api/rentals/listings/${l.id}`)).status).toBe(404);
      expect((await request(app).get(`/api/rentals/listings/${l.id}`).set(bearer(owner.accessToken))).status).toBe(200);
      expect((await request(app).get(`/api/rentals/listings/${l.id}`).set(bearer(admin.accessToken))).status).toBe(200);
      expect((await request(app).get(`/api/rentals/listings/${l.id}/quote?startAt=${hoursFromNow(48).toISOString()}&endAt=${hoursFromNow(52).toISOString()}`)).status).toBe(404);

      await request(app).post(`/api/rentals/listings/${l.id}/activate`).set(bearer(owner.accessToken));
      expect(ids(await search(""))).toEqual([l.id]);
    });

    it("lists only the caller's own listings under /mine", async () => {
      const a = await registerOwner(app);
      const b = await registerOwner(app);
      const la = await createRentalListing(app, a, vt);
      await createRentalListing(app, b, vt);
      const res = await request(app).get("/api/rentals/listings/mine").set(bearer(a.accessToken));
      expect(res.body.data.listings.map((l: { id: string }) => l.id)).toEqual([la.id]);
    });

    it("a deactivated listing refuses new bookings but honours existing ones", async () => {
      const owner = await registerOwner(app);
      const renter = await registerRenter(app);
      const l = await createRentalListing(app, owner, vt);
      const b = await confirmedBooking(app, renter, l.id);
      await request(app).post(`/api/rentals/listings/${l.id}/deactivate`).set(bearer(owner.accessToken));
      expect((await request(app).get(`/api/rentals/bookings/${b.id}`).set(bearer(renter.accessToken))).body.data.booking.status).toBe("CONFIRMED");
      const other = await registerRenter(app);
      expect((await book(app, other, l.id, hoursFromNow(100), hoursFromNow(104))).status).toBe(404);
    });
  });

  describe("search", () => {
    it("filters by daily price (hourly-only listings use 24 x hourly) and text/fuel/transmission", async () => {
      const o = await registerOwner(app);
      const cheap = await createRentalListing(app, o, vt, { dailyPrice: 500, hourlyPrice: undefined }, { brand: "Maruti", model: "Alto" });
      const mid = await createRentalListing(app, o, vt, { dailyPrice: undefined, hourlyPrice: 50 }, { brand: "Honda", model: "City" }); // 1200/day
      const dear = await createRentalListing(app, o, vt, { dailyPrice: 3000 }, { brand: "BMW", model: "X5" });
      expect(ids(await search("maxDailyPrice=600"))).toEqual([cheap.id]);
      expect(ids(await search("minDailyPrice=1000&maxDailyPrice=2000"))).toEqual([mid.id]);
      expect(ids(await search("minDailyPrice=2500"))).toEqual([dear.id]);
      expect(ids(await search("q=alto"))).toEqual([cheap.id]);
      expect(ids(await search("q=zzz"))).toEqual([]);
      expect(ids(await search("fuelType=ELECTRIC"))).toEqual([]);
    });

    it("treats LIKE wildcards in q literally", async () => {
      const o = await registerOwner(app);
      await createRentalListing(app, o, vt);
      expect(ids(await search("q=%25"))).toEqual([]);
      expect(ids(await search("q=_"))).toEqual([]);
    });

    it("finds listings near a point, sorted by distance, with the distance reported", async () => {
      const o = await registerOwner(app);
      const far = await createRentalListing(app, o, vt, { ...offsetMeters(4000) });
      const near = await createRentalListing(app, o, vt, { ...offsetMeters(500) });
      const out = await createRentalListing(app, o, vt, { ...offsetMeters(30000) });
      const res = await search(`lat=12.9716&lng=77.5946&radiusMeters=10000&sort=distance`);
      expect(ids(res)).toEqual([near.id, far.id]);
      expect(res.body.data.listings[0].distanceMeters).toBeGreaterThan(400);
      expect(res.body.data.listings[0].distanceMeters).toBeLessThan(600);
      expect(ids(res)).not.toContain(out.id);
      expect((await search("sort=distance")).status).toBe(400);
      expect((await search("lat=12.9")).status).toBe(400);
    });

    it("availability filter excludes listings booked in the window, but not for adjacent or lapsed-hold windows", async () => {
      const o = await registerOwner(app);
      const r = await registerRenter(app);
      const booked = await createRentalListing(app, o, vt);
      const free = await createRentalListing(app, o, vt);
      const held = await createRentalListing(app, o, vt);
      await confirmedBooking(app, r, booked.id, 48, 53);
      const pending = await bookOk(app, r, held.id, 48, 53); // PENDING_PAYMENT hold, still live
      const q = (a: number, b: number) => `availableFrom=${encodeURIComponent(hoursFromNow(a).toISOString())}&availableTo=${encodeURIComponent(hoursFromNow(b).toISOString())}`;

      expect(ids(await search(q(50, 51))).sort()).toEqual([free.id].sort());
      expect(ids(await search(q(53.5, 55))).sort()).toEqual([booked.id, free.id, held.id].sort()); // after the booking ends
      await lapseHold(pending.id, 60_000);
      expect(ids(await search(q(50, 51))).sort()).toEqual([free.id, held.id].sort()); // a lapsed hold no longer blocks
      expect((await search(`availableFrom=${hoursFromNow(5).toISOString()}`)).status).toBe(400);
      expect((await search(q(55, 50))).status).toBe(400);
    });

    it("paginates with a keyset cursor: no skips, no repeats, stable across inserts", async () => {
      const o = await registerOwner(app);
      const made: string[] = [];
      for (let i = 0; i < 5; i++) made.push((await createRentalListing(app, o, vt, { dailyPrice: 500 + i * 100 })).id);

      for (const sort of ["newest", "price_asc"]) {
        const seen: string[] = [];
        let cursor: string | null = null;
        let guard = 0;
        do {
          const res: request.Response = await search(`sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
          seen.push(...ids(res));
          cursor = res.body.data.nextCursor;
          if (guard === 0) await createRentalListing(app, o, vt, { dailyPrice: 9999 }); // insert mid-pagination
        } while (cursor && ++guard < 10);
        expect(new Set(seen).size).toBe(seen.length);
        for (const id of made) expect(seen).toContain(id);
      }
      expect((await search("cursor=garbage")).status).toBe(400);
      const c = (await search("limit=1")).body.data.nextCursor;
      expect((await search(`sort=price_asc&cursor=${c}`)).status).toBe(400); // cursor belongs to another sort
    });
  });

  describe("quote and availability calendar", () => {
    it("prices hourly + daily combinations exactly", async () => {
      const o = await registerOwner(app);
      const l = await createRentalListing(app, o, vt); // 100/h, 800/day, deposit 2000
      const quote = async (hours: number, mins = 0) => {
        const s = hoursFromNow(48);
        const e = new Date(s.getTime() + hours * 3_600_000 + mins * 60_000);
        return (await request(app).get(`/api/rentals/listings/${l.id}/quote?startAt=${s.toISOString()}&endAt=${e.toISOString()}`)).body.data.quote;
      };
      expect(await quote(5)).toMatchObject({ billedHours: 5, rentAmount: 500, depositAmount: 2000, totalDue: 2500, available: true });
      expect(await quote(1, 30)).toMatchObject({ billedHours: 2, rentAmount: 200 }); // rounded up
      expect(await quote(23)).toMatchObject({ rentAmount: 800 }); // never more than a day
      expect(await quote(30)).toMatchObject({ days: 1, remainingHours: 6, rentAmount: 1400 });
      expect(await quote(72)).toMatchObject({ days: 3, rentAmount: 2400 });
    });

    it("rejects invalid windows and reflects availability", async () => {
      const o = await registerOwner(app);
      const r = await registerRenter(app);
      const l = await createRentalListing(app, o, vt);
      const q = (a: Date, b: Date) => request(app).get(`/api/rentals/listings/${l.id}/quote?startAt=${a.toISOString()}&endAt=${b.toISOString()}`);
      expect((await q(hoursFromNow(-2), hoursFromNow(5))).status).toBe(400);
      expect((await q(hoursFromNow(48), hoursFromNow(48.5))).status).toBe(400);
      expect((await q(hoursFromNow(48), hoursFromNow(48 + 31 * 24))).status).toBe(400);
      expect((await request(app).get(`/api/rentals/listings/${l.id}/quote?startAt=nope&endAt=nope`)).status).toBe(400);

      await bookOk(app, r, l.id, 48, 53);
      expect((await q(hoursFromNow(50), hoursFromNow(54))).body.data.quote.available).toBe(false);
      expect((await q(hoursFromNow(53), hoursFromNow(57))).body.data.quote.available).toBe(true); // [start, end) is half-open
    });

    it("exposes blocked ranges without any renter details", async () => {
      const o = await registerOwner(app);
      const r = await registerRenter(app);
      const l = await createRentalListing(app, o, vt);
      await confirmedBooking(app, r, l.id, 48, 53);
      const res = await request(app).get(`/api/rentals/listings/${l.id}/availability`);
      expect(res.status).toBe(200);
      expect(res.body.data.blocked).toHaveLength(1);
      expect(Object.keys(res.body.data.blocked[0]).sort()).toEqual(["endAt", "startAt"]);
      expect((await request(app).get(`/api/rentals/listings/${l.id}/availability?from=${hoursFromNow(1).toISOString()}&to=${hoursFromNow(24 * 100).toISOString()}`)).status).toBe(400);
    });
  });
});

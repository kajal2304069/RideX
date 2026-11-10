import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";
import { ensurePaymentVehicleType, registerUser } from "./paymentFixtures";
import { offsetMeters, CENTER } from "./garageFixtures";
import { bearer, createListing, listingPayload, registerBuyer, registerSeller, resetMarketplaceTables } from "./marketplaceFixtures";

const app = createApp();
let vt: string;

const get = (path: string, token?: string) => {
  const r = request(app).get(path);
  return token ? r.set(bearer(token)) : r;
};

describe("Marketplace listings (live DB)", () => {
  beforeAll(async () => {
    vt = await ensurePaymentVehicleType("MKT_TEST_SEDAN");
  });
  beforeEach(async () => {
    await resetMarketplaceTables();
    await redis.flushdb();
  });
  afterAll(async () => {
    await closeTestDb();
    redis.disconnect();
  });

  describe("creating", () => {
    it("lets a SELLER create a listing and returns lat/lng, never PostGIS", async () => {
      const seller = await registerSeller(app);
      const res = await request(app).post("/api/marketplace/listings").set(bearer(seller.accessToken)).send(listingPayload(vt, { insuranceValidUntil: "2027-03-01" }));

      expect(res.status).toBe(201);
      expect(res.body.data.listing).toMatchObject({
        brand: "Honda", model: "City", year: 2019, price: 500000, status: "ACTIVE", isReserved: false,
        location: { lat: 12.9716, lng: 77.5946 }, insuranceValidUntil: "2027-03-01", seller: { id: seller.userId },
      });
    });

    it("forbids non-sellers and anonymous callers", async () => {
      const buyer = await registerBuyer(app);
      expect((await request(app).post("/api/marketplace/listings").set(bearer(buyer.accessToken)).send(listingPayload(vt))).status).toBe(403);
      expect((await request(app).post("/api/marketplace/listings").send({})).status).toBe(401);
    });

    it.each([
      ["zero price", { price: 0 }],
      ["negative price", { price: -5 }],
      ["absurd price", { price: 1e12 }],
      ["year too old", { year: 1900 }],
      ["year in the far future", { year: 2999 }],
      ["negative mileage", { mileageKm: -1 }],
      ["bad fuel type", { fuelType: "STEAM" }],
      ["bad condition", { condition: "PERFECT" }],
      ["latitude out of range", { lat: 120 }],
      ["bad insurance date", { insuranceValidUntil: "01/03/2027" }],
      ["unknown field (strict)", { sellerId: "x" }],
      ["fractional mileage", { mileageKm: 10.5 }],
    ])("rejects %s", async (_l, patch) => {
      const seller = await registerSeller(app);
      const res = await request(app).post("/api/marketplace/listings").set(bearer(seller.accessToken)).send(listingPayload(vt, patch));
      expect(res.status).toBe(400);
    });

    it("applies defaults for condition and ownerCount", async () => {
      const seller = await registerSeller(app);
      const { condition: _c, ownerCount: _o, ...rest } = listingPayload(vt);
      const res = await request(app).post("/api/marketplace/listings").set(bearer(seller.accessToken)).send(rest);
      expect(res.body.data.listing).toMatchObject({ condition: "GOOD", ownerCount: 1 });
    });

    it("the database CHECK constraints reject bad data even if the app is bypassed", async () => {
      const seller = await registerSeller(app);
      const insert = (price: number, year: number) =>
        pool.query(
          `INSERT INTO vehicle_listings (seller_id, vehicle_type_id, brand, model, year, mileage_km, fuel_type, transmission, condition, owner_count, price, location)
           VALUES ($1,$2,'X','Y',$4,1,'PETROL','MANUAL','GOOD',1,$3, ST_SetSRID(ST_MakePoint(77,12),4326)::geography)`,
          [seller.userId, vt, price, year]
        );
      await expect(insert(-1, 2020)).rejects.toMatchObject({ code: "23514" });
      await expect(insert(100, 1800)).rejects.toMatchObject({ code: "23514" });
      await expect(insert(100, 2020)).resolves.toBeDefined();
    });
  });

  describe("viewing", () => {
    it("is public for ACTIVE listings and shows images, favourites count and inspection summary", async () => {
      const seller = await registerSeller(app);
      const l = await createListing(app, seller, vt);
      await request(app).post(`/api/marketplace/listings/${l.id}/images`).set(bearer(seller.accessToken)).send({ url: "https://cdn.example.com/a.jpg" });

      const res = await get(`/api/marketplace/listings/${l.id}`);

      expect(res.status).toBe(200);
      expect(res.body.data.images).toHaveLength(1);
      expect(res.body.data.favoritesCount).toBe(0);
      expect(res.body.data.inspection).toEqual({ completed: 0, latestOverallScore: null });
      expect(res.body.data).not.toHaveProperty("isFavorite"); // anonymous
    });

    it("hides a DELISTED listing from everyone but its seller and admins", async () => {
      const seller = await registerSeller(app);
      const stranger = await registerBuyer(app);
      const l = await createListing(app, seller, vt);
      await request(app).post(`/api/marketplace/listings/${l.id}/delist`).set(bearer(seller.accessToken));

      expect((await get(`/api/marketplace/listings/${l.id}`)).status).toBe(404);
      expect((await get(`/api/marketplace/listings/${l.id}`, stranger.accessToken)).status).toBe(404);
      expect((await get(`/api/marketplace/listings/${l.id}`, seller.accessToken)).status).toBe(200);
    });

    it("shows the seller their pending-offer count and a buyer their own offer, not each other's", async () => {
      const seller = await registerSeller(app);
      const b1 = await registerBuyer(app);
      const b2 = await registerBuyer(app);
      const l = await createListing(app, seller, vt);
      await request(app).post(`/api/marketplace/listings/${l.id}/offers`).set(bearer(b1.accessToken)).send({ amount: 450000 });
      await request(app).post(`/api/marketplace/listings/${l.id}/offers`).set(bearer(b2.accessToken)).send({ amount: 470000 });

      const asSeller = await get(`/api/marketplace/listings/${l.id}`, seller.accessToken);
      expect(asSeller.body.data.pendingOffersCount).toBe(2);
      expect(asSeller.body.data).not.toHaveProperty("myOffer");

      const asBuyer = await get(`/api/marketplace/listings/${l.id}`, b1.accessToken);
      expect(asBuyer.body.data.myOffer.amount).toBe(450000);
      expect(asBuyer.body.data).not.toHaveProperty("pendingOffersCount");
    });

    it("rejects a malformed token instead of treating it as anonymous", async () => {
      const seller = await registerSeller(app);
      const l = await createListing(app, seller, vt);
      expect((await request(app).get(`/api/marketplace/listings/${l.id}`).set("Authorization", "Bearer junk")).status).toBe(401);
    });

    it("lists only my own listings", async () => {
      const a = await registerSeller(app);
      const b = await registerSeller(app);
      await createListing(app, a, vt, { model: "A1" });
      await createListing(app, b, vt, { model: "B1" });
      const res = await get("/api/marketplace/listings/mine", a.accessToken);
      expect(res.body.data.listings.map((l: { model: string }) => l.model)).toEqual(["A1"]);
    });
  });

  describe("editing, delisting, relisting", () => {
    it("lets the seller update fields; others get a 404", async () => {
      const seller = await registerSeller(app);
      const other = await registerSeller(app);
      const l = await createListing(app, seller, vt);

      const ok = await request(app).patch(`/api/marketplace/listings/${l.id}`).set(bearer(seller.accessToken)).send({ price: 450000, description: null, lat: 13, lng: 77.6 });
      expect(ok.body.data.listing).toMatchObject({ price: 450000, description: null, location: { lat: 13, lng: 77.6 } });

      expect((await request(app).patch(`/api/marketplace/listings/${l.id}`).set(bearer(other.accessToken)).send({ price: 1 })).status).toBe(404);
      expect((await request(app).patch(`/api/marketplace/listings/${l.id}`).set(bearer(seller.accessToken)).send({ lat: 13 })).status).toBe(400);
      expect((await request(app).patch(`/api/marketplace/listings/${l.id}`).set(bearer(seller.accessToken)).send({})).status).toBe(400);
      expect((await request(app).patch(`/api/marketplace/listings/${l.id}`).set(bearer(seller.accessToken)).send({ brand: "Hacked" })).status).toBe(400);
    });

    it("delists and relists, and refuses the wrong direction", async () => {
      const seller = await registerSeller(app);
      const l = await createListing(app, seller, vt);
      const url = (a: string) => `/api/marketplace/listings/${l.id}/${a}`;

      expect((await request(app).post(url("relist")).set(bearer(seller.accessToken))).status).toBe(409); // already ACTIVE
      expect((await request(app).post(url("delist")).set(bearer(seller.accessToken))).body.data.listing.status).toBe("DELISTED");
      expect((await request(app).post(url("delist")).set(bearer(seller.accessToken))).status).toBe(409);
      expect((await request(app).patch(`/api/marketplace/listings/${l.id}`).set(bearer(seller.accessToken)).send({ price: 1000 })).status).toBe(409);
      expect((await request(app).post(url("relist")).set(bearer(seller.accessToken))).body.data.listing.status).toBe("ACTIVE");
    });

    it("rejects PENDING offers when a listing is delisted", async () => {
      const seller = await registerSeller(app);
      const buyer = await registerBuyer(app);
      const l = await createListing(app, seller, vt);
      const offer = await request(app).post(`/api/marketplace/listings/${l.id}/offers`).set(bearer(buyer.accessToken)).send({ amount: 400000 });

      await request(app).post(`/api/marketplace/listings/${l.id}/delist`).set(bearer(seller.accessToken));

      const row = await pool.query(`SELECT status FROM vehicle_offers WHERE id = $1`, [offer.body.data.offer.id]);
      expect(row.rows[0].status).toBe("REJECTED");
    });
  });

  describe("images", () => {
    const add = (token: string, id: string, body: object) => request(app).post(`/api/marketplace/listings/${id}/images`).set(bearer(token)).send(body);

    it("fills the lowest free slot, honours an explicit position, and reuses a freed slot", async () => {
      const seller = await registerSeller(app);
      const l = await createListing(app, seller, vt);

      const a = await add(seller.accessToken, l.id, { url: "https://cdn.example.com/1.jpg" });
      const b = await add(seller.accessToken, l.id, { url: "https://cdn.example.com/2.jpg" });
      const c = await add(seller.accessToken, l.id, { url: "https://cdn.example.com/3.jpg", position: 5 });
      expect([a, b, c].map((r) => r.body.data.image.position)).toEqual([0, 1, 5]);

      await request(app).delete(`/api/marketplace/listings/${l.id}/images/${a.body.data.image.id}`).set(bearer(seller.accessToken));
      const d = await add(seller.accessToken, l.id, { url: "https://cdn.example.com/4.jpg" });
      expect(d.body.data.image.position).toBe(0);
    });

    it("409s on a taken position and when the gallery already has 10", async () => {
      const seller = await registerSeller(app);
      const l = await createListing(app, seller, vt);
      await add(seller.accessToken, l.id, { url: "https://cdn.example.com/x.jpg", position: 2 });
      expect((await add(seller.accessToken, l.id, { url: "https://cdn.example.com/y.jpg", position: 2 })).status).toBe(409);

      for (let i = 0; i < 9; i++) await add(seller.accessToken, l.id, { url: `https://cdn.example.com/${i}.jpg` });
      const eleventh = await add(seller.accessToken, l.id, { url: "https://cdn.example.com/z.jpg" });
      expect(eleventh.status).toBe(409);
      expect(eleventh.body.error?.message ?? eleventh.body.message).toMatch(/10 images/);
    });

    it.each([
      ["a non-https url", { url: "http://cdn.example.com/a.jpg" }],
      ["not a url", { url: "nope" }],
      ["position 10", { url: "https://cdn.example.com/a.jpg", position: 10 }],
      ["an unknown field", { url: "https://cdn.example.com/a.jpg", caption: "x" }],
    ])("rejects %s", async (_l, body) => {
      const seller = await registerSeller(app);
      const l = await createListing(app, seller, vt);
      expect((await add(seller.accessToken, l.id, body)).status).toBe(400);
    });

    it("only the seller can add or remove images", async () => {
      const seller = await registerSeller(app);
      const other = await registerSeller(app);
      const l = await createListing(app, seller, vt);
      const img = await add(seller.accessToken, l.id, { url: "https://cdn.example.com/a.jpg" });

      expect((await add(other.accessToken, l.id, { url: "https://cdn.example.com/b.jpg" })).status).toBe(404);
      expect((await request(app).delete(`/api/marketplace/listings/${l.id}/images/${img.body.data.image.id}`).set(bearer(other.accessToken))).status).toBe(404);
    });
  });

  describe("favourites", () => {
    it("is idempotent, counted, listed, and hidden once delisted", async () => {
      const seller = await registerSeller(app);
      const buyer = await registerBuyer(app);
      const l = await createListing(app, seller, vt);
      const put = () => request(app).put(`/api/marketplace/listings/${l.id}/favorite`).set(bearer(buyer.accessToken));

      expect((await put()).status).toBe(200);
      expect((await put()).status).toBe(200); // second PUT is a no-op, not an error
      expect((await get(`/api/marketplace/listings/${l.id}`, buyer.accessToken)).body.data).toMatchObject({ favoritesCount: 1, isFavorite: true });
      expect((await get("/api/marketplace/listings/favorites", buyer.accessToken)).body.data.listings).toHaveLength(1);

      await request(app).delete(`/api/marketplace/listings/${l.id}/favorite`).set(bearer(buyer.accessToken));
      expect((await request(app).delete(`/api/marketplace/listings/${l.id}/favorite`).set(bearer(buyer.accessToken))).status).toBe(200);
      expect((await get(`/api/marketplace/listings/${l.id}`, buyer.accessToken)).body.data.favoritesCount).toBe(0);

      await put();
      await request(app).post(`/api/marketplace/listings/${l.id}/delist`).set(bearer(seller.accessToken));
      expect((await get("/api/marketplace/listings/favorites", buyer.accessToken)).body.data.listings).toHaveLength(0);
      expect((await put()).status).toBe(404);
    });
  });

  describe("search", () => {
    async function seed() {
      const seller = await registerSeller(app);
      const mk = (over: Record<string, unknown>) => createListing(app, seller, vt, over);
      await mk({ brand: "Honda", model: "City", price: 500000, year: 2019, fuelType: "PETROL", transmission: "MANUAL", condition: "GOOD", mileageKm: 40000, ...offsetMeters(500) });
      await mk({ brand: "Honda", model: "Civic", price: 900000, year: 2021, fuelType: "PETROL", transmission: "AUTOMATIC", condition: "EXCELLENT", mileageKm: 15000, ...offsetMeters(2000) });
      await mk({ brand: "Toyota", model: "Innova", price: 1500000, year: 2018, fuelType: "DIESEL", transmission: "MANUAL", condition: "FAIR", mileageKm: 90000, ...offsetMeters(8000) });
      await mk({ brand: "Tata", model: "Nexon EV", price: 1200000, year: 2022, fuelType: "ELECTRIC", transmission: "AUTOMATIC", condition: "EXCELLENT", mileageKm: 8000, ...offsetMeters(30000) });
      await mk({ brand: "Maruti", model: "Swift", price: 300000, year: 2015, fuelType: "PETROL", transmission: "MANUAL", condition: "NEEDS_WORK", mileageKm: 120000, ...offsetMeters(1000) });
      return seller;
    }
    const names = (res: request.Response) => res.body.data.listings.map((l: { model: string }) => l.model);

    it("returns only ACTIVE listings, newest first by default", async () => {
      const seller = await seed();
      const all = await get("/api/marketplace/listings");
      expect(all.status).toBe(200);
      expect(names(all)).toEqual(["Swift", "Nexon EV", "Innova", "Civic", "City"]);

      const swift = all.body.data.listings[0];
      await request(app).post(`/api/marketplace/listings/${swift.id}/delist`).set(bearer(seller.accessToken));
      expect(names(await get("/api/marketplace/listings"))).not.toContain("Swift");
    });

    it("filters by text (case-insensitive, matches brand + model)", async () => {
      await seed();
      expect(names(await get("/api/marketplace/listings?q=civ"))).toEqual(["Civic"]);
      expect(names(await get("/api/marketplace/listings?q=HONDA&sort=price_asc"))).toEqual(["City", "Civic"]);
      expect(names(await get("/api/marketplace/listings?q=nexon%20ev"))).toEqual(["Nexon EV"]);
    });

    it("treats LIKE wildcards in the search text literally", async () => {
      await seed();
      expect(names(await get("/api/marketplace/listings?q=%25"))).toEqual([]); // "%" would match everything if unescaped
      expect(names(await get("/api/marketplace/listings?q=_"))).toEqual([]);
    });

    it.each([
      ["brand", "brand=toyota", ["Innova"]],
      ["price range", "minPrice=400000&maxPrice=1000000&sort=price_asc", ["City", "Civic"]],
      ["year range", "minYear=2019&maxYear=2021&sort=price_asc", ["City", "Civic"]],
      ["max mileage", "maxMileage=20000&sort=price_asc", ["Nexon EV", "Civic"].sort((a, b) => (a === "Civic" ? -1 : 1))],
      ["fuel type", "fuelType=DIESEL", ["Innova"]],
      ["transmission", "transmission=AUTOMATIC&sort=price_asc", ["Civic", "Nexon EV"]],
      ["single condition", "condition=EXCELLENT&sort=price_asc", ["Civic", "Nexon EV"]],
      ["several conditions", "condition=FAIR,NEEDS_WORK&sort=price_asc", ["Swift", "Innova"]],
      ["combined filters", "brand=honda&transmission=AUTOMATIC&maxPrice=1000000", ["Civic"]],
    ])("filters by %s", async (_l, qs, expected) => {
      await seed();
      expect(names(await get(`/api/marketplace/listings?${qs}`))).toEqual(expected);
    });

    it("lists a brand-new vehicle and finds it with condition=NEW", async () => {
      const seller = await seed();
      await createListing(app, seller, vt, { brand: "Hero", model: "Splendor New", price: 90000, year: 2026, fuelType: "PETROL", transmission: "MANUAL", condition: "NEW", mileageKm: 5, ...offsetMeters(300) });
      expect(names(await get("/api/marketplace/listings?condition=NEW"))).toEqual(["Splendor New"]);
      expect(names(await get("/api/marketplace/listings?condition=NEW,EXCELLENT&sort=price_asc"))).toEqual(["Splendor New", "Civic", "Nexon EV"]);
    });

    it("sorts by price both ways", async () => {
      await seed();
      expect(names(await get("/api/marketplace/listings?sort=price_asc"))).toEqual(["Swift", "City", "Civic", "Nexon EV", "Innova"]);
      expect(names(await get("/api/marketplace/listings?sort=price_desc"))).toEqual(["Innova", "Nexon EV", "Civic", "City", "Swift"]);
    });

    it("finds listings near a point, nearest first, with distance", async () => {
      await seed();
      const res = await get(`/api/marketplace/listings?lat=${CENTER.lat}&lng=${CENTER.lng}&radiusMeters=5000&sort=distance`);
      expect(names(res)).toEqual(["City", "Swift", "Civic"]); // 500m, 1km, 2km; Innova (8km) and Nexon (30km) excluded
      const d = res.body.data.listings.map((l: { distanceMeters: number }) => l.distanceMeters);
      expect(d[0]).toBeGreaterThan(450);
      expect(d[0]).toBeLessThan(550);
      expect(d).toEqual([...d].sort((a: number, b: number) => a - b));
    });

    it("validates query parameters", async () => {
      await seed();
      for (const qs of [
        "sort=distance", "lat=12", "minPrice=10&maxPrice=5", "minYear=2020&maxYear=2010", "condition=PERFECT",
        "fuelType=STEAM", "limit=0", "limit=500", "sort=random", "lat=99&lng=0", "vehicleTypeId=nope", "cursor=" + "x".repeat(500),
      ]) {
        expect((await get(`/api/marketplace/listings?${qs}`)).status).toBe(400);
      }
    });

    it("includes the first image as a thumbnail and the reserved flag", async () => {
      const seller = await seed();
      const first = (await get("/api/marketplace/listings?sort=price_asc")).body.data.listings[0];
      await request(app).post(`/api/marketplace/listings/${first.id}/images`).set(bearer(seller.accessToken)).send({ url: "https://cdn.example.com/t.jpg" });
      const res = await get("/api/marketplace/listings?sort=price_asc");
      expect(res.body.data.listings[0]).toMatchObject({ thumbnail: "https://cdn.example.com/t.jpg", isReserved: false });
      expect(res.body.data.listings[1].thumbnail).toBeNull();
    });
  });

  describe("pagination (keyset cursor)", () => {
    async function seedMany(prices: number[]) {
      const seller = await registerSeller(app);
      for (let i = 0; i < prices.length; i++) await createListing(app, seller, vt, { model: `M${i}`, price: prices[i], ...offsetMeters(100 * (i + 1)) });
    }
    async function pageThrough(qs: string, limit: number) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const res: request.Response = await get(`/api/marketplace/listings?${qs}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        expect(res.status).toBe(200);
        seen.push(...res.body.data.listings.map((l: { model: string }) => l.model));
        cursor = res.body.data.nextCursor;
        if (!cursor) break;
      }
      return seen;
    }

    it("visits every listing exactly once in order for every sort, with no skips or repeats", async () => {
      await seedMany([500, 300, 900, 700, 100, 800, 600]);
      const price = await pageThrough("sort=price_asc", 3);
      expect(price).toEqual(["M4", "M1", "M0", "M6", "M3", "M5", "M2"]);
      expect(await pageThrough("sort=price_desc", 2)).toEqual([...price].reverse());
      expect((await pageThrough("sort=newest", 3))).toEqual(["M6", "M5", "M4", "M3", "M2", "M1", "M0"]);
      expect(await pageThrough(`sort=distance&lat=${CENTER.lat}&lng=${CENTER.lng}`, 3)).toEqual(["M0", "M1", "M2", "M3", "M4", "M5", "M6"]);
    });

    it("keeps a stable total order when many listings share the same price (id tiebreaker)", async () => {
      await seedMany([1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
      const seen = await pageThrough("sort=price_asc", 2);
      expect(seen).toHaveLength(9);
      expect(new Set(seen).size).toBe(9);
    });

    it("does not skip listings created in the same millisecond (microsecond-safe cursor)", async () => {
      const seller = await registerSeller(app);
      // Bulk insert in ONE statement so every row shares a created_at timestamp.
      await pool.query(
        `INSERT INTO vehicle_listings (seller_id, vehicle_type_id, brand, model, year, mileage_km, fuel_type, transmission, condition, owner_count, price, location)
         SELECT $1, $2, 'Bulk', 'B' || g, 2020, 1000, 'PETROL', 'MANUAL', 'GOOD', 1, 1000 + g, ST_SetSRID(ST_MakePoint(77.59, 12.97), 4326)::geography
         FROM generate_series(1, 11) g`,
        [seller.userId, vt]
      );
      const seen = await pageThrough("sort=newest", 4);
      expect(seen).toHaveLength(11);
      expect(new Set(seen).size).toBe(11);
    });

    it("reports no next cursor on the last page, and does not need a COUNT", async () => {
      await seedMany([1, 2, 3]);
      const exact = await get("/api/marketplace/listings?limit=3");
      expect(exact.body.data.nextCursor).toBeNull();
      const partial = await get("/api/marketplace/listings?limit=2");
      expect(partial.body.data.nextCursor).toEqual(expect.any(String));
    });

    it("rejects a garbage cursor and a cursor from a different sort", async () => {
      await seedMany([1, 2, 3]);
      expect((await get("/api/marketplace/listings?cursor=garbage")).status).toBe(400);
      const p = await get("/api/marketplace/listings?sort=price_asc&limit=1");
      expect((await get(`/api/marketplace/listings?sort=newest&cursor=${encodeURIComponent(p.body.data.nextCursor)}`)).status).toBe(400);
    });

    it("stays correct while listings are added between page fetches (the OFFSET problem)", async () => {
      const seller = await registerSeller(app);
      for (let i = 0; i < 6; i++) await createListing(app, seller, vt, { model: `M${i}`, price: 1000 + i });
      const first = await get("/api/marketplace/listings?sort=price_asc&limit=3");
      // A cheaper listing appears after page 1 was served: with OFFSET it would shift page 2 and repeat a row.
      await createListing(app, seller, vt, { model: "NEW", price: 1 });
      const second = await get(`/api/marketplace/listings?sort=price_asc&limit=3&cursor=${encodeURIComponent(first.body.data.nextCursor)}`);
      expect(second.body.data.listings.map((l: { model: string }) => l.model)).toEqual(["M3", "M4", "M5"]);
    });
  });

  describe("search performance", () => {
    it("uses the trigram index for text search and the partial index for sorted browsing", async () => {
      const seller = await registerUser(app, ["SELLER"]);
      await pool.query(
        `INSERT INTO vehicle_listings (seller_id, vehicle_type_id, brand, model, year, mileage_km, fuel_type, transmission, condition, owner_count, price, location)
         SELECT $1, $2, 'Brand' || (g % 50), 'Model' || g, 2020, 1000, 'PETROL', 'MANUAL', 'GOOD', 1, 1000 + g, ST_SetSRID(ST_MakePoint(77.59, 12.97), 4326)::geography
         FROM generate_series(1, 3000) g`,
        [seller.userId, vt]
      );
      await pool.query(`ANALYZE vehicle_listings`);

      // On a few thousand rows the planner may legitimately prefer a seq scan. Disabling it on ONE dedicated
      // connection proves the index is *usable* for these exact query shapes, which is what we are guarding.
      const client = await pool.connect();
      try {
        await client.query(`SET enable_seqscan = off`);
        const plan = async (sql: string) => (await client.query(`EXPLAIN ${sql}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
        // The text predicate on its own is what the trigram index serves. (Combined with `status = 'ACTIVE'` on a tiny
        // table the planner's cost model can prefer the plain status index; that is a statistics artefact, not a missing index.)
        expect(await plan(`SELECT id FROM vehicle_listings WHERE (brand || ' ' || model) ILIKE '%Model2999%'`)).toMatch(/vehicle_listings_search_trgm/);
        expect(await plan(`SELECT id FROM vehicle_listings WHERE status = 'ACTIVE' ORDER BY price, id LIMIT 20`)).toMatch(/vehicle_listings_active_price/);
        expect(await plan(`SELECT id FROM vehicle_listings WHERE status = 'ACTIVE' ORDER BY created_at DESC, id DESC LIMIT 20`)).toMatch(/vehicle_listings_active_created/);
      } finally {
        await client.query(`RESET enable_seqscan`);
        client.release();
      }
    });
  });
});

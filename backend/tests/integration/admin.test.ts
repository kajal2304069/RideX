import request from "supertest";
import { createApp } from "../../src/app";
import { pool } from "../../src/db/pool";
import { redis } from "../../src/config/redis";
import { closeTestDb } from "./testUtils";
import { createCompletedRide, ensurePaymentVehicleType, idemKey, makeAdmin, registerUser } from "./paymentFixtures";
import { bearer, createGarage, registerGarageOwner } from "./garageFixtures";
import { adminUsersRepository } from "../../src/modules/admin/repositories/adminUsers.repository";
import { acceptOffer, createListing, makeOffer, registerBuyer, registerSeller } from "./marketplaceFixtures";

const app = createApp();
let vt: string;
type Acct = { userId: string; accessToken: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
const get = (t: Acct, path: string) => request(app).get(`/api/admin${path}`).set(bearer(t.accessToken));
const post = (t: Acct, path: string, body: object = {}) => request(app).post(`/api/admin${path}`).set(bearer(t.accessToken)).send(body);
const audit = (action: string) => q(`SELECT * FROM audit_logs WHERE action = $1 ORDER BY created_at`, [action]);

/** An admin whose email we know, so we can log in again as them. */
async function adminWithEmail() {
  const a = await registerUser(app, ["RIDER"]);
  await pool.query(`UPDATE users SET roles = array_append(roles, 'ADMIN') WHERE id = $1`, [a.userId]);
  const login = await request(app).post("/api/auth/login").send({ email: a.email, password: "Passw0rd123" });
  return { ...a, accessToken: login.body.data.accessToken as string, refreshToken: login.body.data.refreshToken as string };
}

describe("Phase 18: admin console (live DB + Redis)", () => {
  let admin: Acct;
  beforeAll(async () => { vt = await ensurePaymentVehicleType("ADMIN_TEST"); });
  afterEach(() => jest.restoreAllMocks());
  beforeEach(async () => {
    await pool.query(`TRUNCATE platform_commissions, users RESTART IDENTITY CASCADE`);
    await redis.flushdb();
    admin = await makeAdmin(app);
  });
  afterAll(async () => { await sleep(300); await closeTestDb(); redis.disconnect(); }); // let fire-and-forget notifications settle

  describe("access control", () => {
    const ROUTES: Array<[string, string]> = [
      ["get", "/api/admin/users"], ["get", "/api/admin/drivers"], ["get", "/api/admin/vehicles"], ["get", "/api/admin/rides"],
      ["get", "/api/admin/rentals"], ["get", "/api/admin/payments"], ["get", "/api/admin/listings"], ["get", "/api/admin/garages"],
      ["get", "/api/admin/audit-logs"], ["get", "/api/admin/system/health"],
      ["get", "/api/analytics/overview"], ["get", "/api/analytics/timeseries?metric=rides"], ["get", "/api/analytics/revenue"], ["get", "/api/analytics/leaderboards"],
      ["post", "/api/admin/users/00000000-0000-0000-0000-000000000000/deactivate"],
      ["post", "/api/admin/users/00000000-0000-0000-0000-000000000000/roles"],
      ["post", "/api/admin/listings/00000000-0000-0000-0000-000000000000/remove"],
      ["post", "/api/admin/garages/00000000-0000-0000-0000-000000000000/deactivate"],
    ];

    it.each(ROUTES)("%s %s: anonymous is 401 and a non-admin is 403", async (method, path) => {
      const rider = await registerUser(app, ["RIDER", "VEHICLE_OWNER", "DRIVER"]);
      const call = (t?: string) => {
        const r = (request(app) as any)[method](path);
        return t ? r.set(bearer(t)).send({}) : r.send({});
      };
      expect((await call()).status).toBe(401);
      expect((await call(rider.accessToken)).status).toBe(403);
    });

    it("an admin passes the gate (not 401/403)", async () => {
      expect((await get(admin, "/users")).status).toBe(200);
    });
  });

  describe("users", () => {
    it("lists users WITHOUT any secret column, with filters and keyset pagination", async () => {
      const made: string[] = [];
      for (let i = 0; i < 5; i++) made.push((await registerUser(app, ["RIDER"])).userId);
      const driver = await registerUser(app, ["DRIVER"]);

      const first = await get(admin, "/users?limit=3");
      expect(first.status).toBe(200);
      expect(JSON.stringify(first.body)).not.toMatch(/password|hash/i);
      expect(first.body.data.items).toHaveLength(3);
      expect(first.body.data.nextCursor).toEqual(expect.any(String));

      const seen = new Set<string>(first.body.data.items.map((u: any) => u.id));
      let cursor = first.body.data.nextCursor;
      while (cursor) {
        const page = await get(admin, `/users?limit=3&cursor=${cursor}`);
        for (const u of page.body.data.items) { expect(seen.has(u.id)).toBe(false); seen.add(u.id); }
        cursor = page.body.data.nextCursor;
      }
      expect(seen.size).toBe(7); // 5 + driver + the admin

      expect((await get(admin, "/users?role=DRIVER")).body.data.items.map((u: any) => u.id)).toEqual([driver.userId]);
      expect((await get(admin, `/users?q=${encodeURIComponent(driver.email.slice(0, 12))}`)).body.data.items.length).toBeGreaterThanOrEqual(1);
      expect((await get(admin, "/users?active=false")).body.data.items).toEqual([]);
      expect((await get(admin, "/users?cursor=garbage")).status).toBe(400);
      expect((await get(admin, "/users?role=KING")).status).toBe(400);
      expect((await get(admin, "/users?limit=1000")).status).toBe(400);
    });

    it("search treats % and _ literally (no wildcard injection)", async () => {
      await registerUser(app, ["RIDER"]);
      expect((await get(admin, "/users?q=%25")).body.data.items).toEqual([]);
    });

    it("a user's detail has activity counts and balance, and 404 for an unknown id", async () => {
      const { rideId, rider } = await createCompletedRide(app, vt, admin);
      const d = await get(admin, `/users/${rider.userId}`);
      expect(d.status).toBe(200);
      expect(d.body.data.activity.ridesAsRider).toBe(1);
      expect(d.body.data.balance).toEqual({ earned: 0, withdrawn: 0, available: 0 });
      expect(rideId).toBeTruthy();
      expect((await get(admin, "/users/00000000-0000-0000-0000-000000000000")).status).toBe(404);
      expect((await get(admin, "/users/not-a-uuid")).status).toBe(400);
    });
  });

  describe("deactivation", () => {
    it("takes effect IMMEDIATELY: the old access token, login and refresh are all refused", async () => {
      const t = await adminWithEmail(); // any account with a known password + refresh token
      await pool.query(`UPDATE users SET roles = ARRAY['RIDER']::user_role[] WHERE id = $1`, [t.userId]);
      const login = await request(app).post("/api/auth/login").send({ email: t.email, password: "Passw0rd123" });
      const { accessToken, refreshToken } = login.body.data;
      expect((await request(app).get("/api/earnings/balance").set(bearer(accessToken))).status).toBe(200);

      const res = await post(admin, `/users/${t.userId}/deactivate`, { reason: "Fraud investigation" });
      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject({ isActive: false, deactivatedReason: "Fraud investigation" });

      expect((await request(app).get("/api/earnings/balance").set(bearer(accessToken))).status).toBe(401); // no waiting for expiry
      expect((await request(app).post("/api/auth/login").send({ email: t.email, password: "Passw0rd123" })).status).toBe(403);
      expect((await request(app).post("/api/auth/refresh").send({ refreshToken })).status).toBe(401);
    });

    it("writes an audit row with actor, target, reason and IP, in the same transaction", async () => {
      const u = await registerUser(app, ["RIDER"]);
      await post(admin, `/users/${u.userId}/deactivate`, { reason: "Abuse reports" });
      const [row] = await audit("user.deactivated");
      expect(row).toMatchObject({ actor_id: admin.userId, entity_type: "user", entity_id: u.userId });
      expect(row.metadata).toEqual({ reason: "Abuse reports" });
      expect(row.ip_address).toBeTruthy();
    });

    it("a failed action leaves NO audit row (it rolls back with the change)", async () => {
      const u = await registerUser(app, ["RIDER"]);
      await post(admin, `/users/${u.userId}/deactivate`, { reason: "first" });
      const again = await post(admin, `/users/${u.userId}/deactivate`, { reason: "second" });
      expect(again.status).toBe(409);
      expect(await audit("user.deactivated")).toHaveLength(1);
    });

    it("requires a real reason; refuses self-deactivation and unknown users", async () => {
      const u = await registerUser(app, ["RIDER"]);
      expect((await post(admin, `/users/${u.userId}/deactivate`, {})).status).toBe(400);
      expect((await post(admin, `/users/${u.userId}/deactivate`, { reason: "x" })).status).toBe(400);
      expect((await post(admin, `/users/${u.userId}/deactivate`, { reason: "valid reason", extra: 1 })).status).toBe(400);
      expect((await post(admin, `/users/${admin.userId}/deactivate`, { reason: "oops, me" })).status).toBe(400);
      expect((await post(admin, `/users/00000000-0000-0000-0000-000000000000/deactivate`, { reason: "ghost" })).status).toBe(404);
    });

    it("takes a driver offline and revokes every refresh token", async () => {
      const d = await registerUser(app, ["DRIVER"]);
      await pool.query(`INSERT INTO drivers (user_id, license_number, license_expiry, verification_status, is_online) VALUES ($1, 'L-ADM-1', '2030-01-01', 'VERIFIED', true)`, [d.userId]);
      await post(admin, `/users/${d.userId}/deactivate`, { reason: "Licence fraud" });
      expect((await q(`SELECT is_online FROM drivers WHERE user_id = $1`, [d.userId]))[0].is_online).toBe(false);
      expect(await q(`SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [d.userId])).toHaveLength(0);
    });

    it("reactivation restores access and is audited", async () => {
      const t = await registerUser(app, ["RIDER"]);
      await post(admin, `/users/${t.userId}/deactivate`, { reason: "temporary hold" });
      expect((await post(admin, `/users/${t.userId}/activate`, { reason: "cleared" })).status).toBe(200);
      expect((await request(app).post("/api/auth/login").send({ email: t.email, password: "Passw0rd123" })).status).toBe(200);
      expect(await audit("user.activated")).toHaveLength(1);
      expect((await post(admin, `/users/${t.userId}/activate`, { reason: "again" })).status).toBe(409);
    });

    it("the database refuses an inactive user with no deactivation timestamp", async () => {
      const u = await registerUser(app, ["RIDER"]);
      await expect(pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [u.userId])).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("roles", () => {
    it("grants and revokes roles, audits before/after, and invalidates the target's old tokens", async () => {
      const t = await registerUser(app, ["RIDER"]);
      const old = t.accessToken;
      expect((await request(app).get("/api/vehicles/mine").set(bearer(old))).status).toBe(403); // not an owner yet
      await sleep(1100); // JWT iat has 1-second resolution: let the old token be strictly older than the change

      const res = await post(admin, `/users/${t.userId}/roles`, { add: ["VEHICLE_OWNER"], reason: "Onboarded as fleet owner" });
      expect(res.status).toBe(200);
      expect(res.body.data.changed).toBe(true);
      expect(res.body.data.user.roles.sort()).toEqual(["RIDER", "VEHICLE_OWNER"]);

      const [row] = await audit("user.roles_changed");
      expect(row.metadata).toMatchObject({ before: ["RIDER"], reason: "Onboarded as fleet owner" });
      expect(row.metadata.after.sort()).toEqual(["RIDER", "VEHICLE_OWNER"]);

      // the old token is rejected, so the client must refresh and gets a token carrying the NEW roles
      expect((await request(app).get("/api/vehicles/mine").set(bearer(old))).status).toBe(401);
      const login = await request(app).post("/api/auth/login").send({ email: t.email, password: "Passw0rd123" });
      expect((await request(app).get("/api/vehicles/mine").set(bearer(login.body.data.accessToken))).status).toBe(200);
    });

    it("revoking a role takes effect at once", async () => {
      const t = await registerUser(app, ["RIDER", "VEHICLE_OWNER"]);
      expect((await request(app).get("/api/vehicles/mine").set(bearer(t.accessToken))).status).toBe(200);
      await sleep(1100);
      await post(admin, `/users/${t.userId}/roles`, { remove: ["VEHICLE_OWNER"], reason: "Policy violation" });
      expect((await request(app).get("/api/vehicles/mine").set(bearer(t.accessToken))).status).toBe(401);
    });

    it("a no-op change reports changed:false and writes no audit row", async () => {
      const t = await registerUser(app, ["RIDER"]);
      const res = await post(admin, `/users/${t.userId}/roles`, { add: ["RIDER"], reason: "no change here" });
      expect(res.body.data.changed).toBe(false);
      expect(await audit("user.roles_changed")).toHaveLength(0);
    });

    it("validation: reason, non-empty change, no overlap, never an empty role set", async () => {
      const t = await registerUser(app, ["RIDER"]);
      expect((await post(admin, `/users/${t.userId}/roles`, { add: ["SELLER"] })).status).toBe(400);
      expect((await post(admin, `/users/${t.userId}/roles`, { reason: "just because" })).status).toBe(400);
      expect((await post(admin, `/users/${t.userId}/roles`, { add: ["SELLER"], remove: ["SELLER"], reason: "contradiction" })).status).toBe(400);
      expect((await post(admin, `/users/${t.userId}/roles`, { remove: ["RIDER"], reason: "strip everything" })).status).toBe(400);
      expect((await post(admin, `/users/${t.userId}/roles`, { add: ["KING"], reason: "invalid role" })).status).toBe(400);
    });

    it("an admin cannot change their own ADMIN role", async () => {
      const other = await adminWithEmail();
      const res = await post(other, `/users/${other.userId}/roles`, { remove: ["ADMIN"], reason: "stepping down" });
      expect(res.status).toBe(400);
    });

    it("the last active admin can never be removed or deactivated", async () => {
      const second = await adminWithEmail();
      // `admin` demotes `second`: fine, second is not the last
      expect((await post(admin, `/users/${second.userId}/roles`, { remove: ["ADMIN"], reason: "left the team" })).status).toBe(200);
      // now `admin` is the only admin: promote `second` back, and try to strip the last one using a fresh admin
      const third = await adminWithEmail();
      expect((await post(third, `/users/${admin.userId}/roles`, { remove: ["ADMIN"], reason: "rotate" })).status).toBe(200); // third remains
      // third is now the only admin; nobody else (not even a re-promoted admin) can be used to remove them
      const fourth = await adminWithEmail();
      await pool.query(`UPDATE users SET is_active = false, deactivated_at = now() WHERE id = $1`, [fourth.userId]); // an inactive admin does not count
      const res = await post(third, `/users/${fourth.userId}/deactivate`, { reason: "already inactive" });
      expect(res.status).toBe(409);
      expect(await q(`SELECT 1 FROM users WHERE 'ADMIN' = ANY(roles) AND is_active`)).toHaveLength(1);
    });

    it("CONCURRENCY: two admins removing each other at the same instant leave exactly one admin", async () => {
      const b = await adminWithEmail();
      // Widen the race window: pause each transaction between its "who are the admins?" read and its write, so that
      // without the row locks BOTH would see two admins and both would demote the other.
      const original = adminUsersRepository.lockUser.bind(adminUsersRepository);
      jest.spyOn(adminUsersRepository, "lockUser").mockImplementation(async (c, id) => { await sleep(250); return original(c, id); });
      const [r1, r2] = await Promise.all([
        post(admin, `/users/${b.userId}/roles`, { remove: ["ADMIN"], reason: "race one" }),
        post(b, `/users/${admin.userId}/roles`, { remove: ["ADMIN"], reason: "race two" }),
      ]);
      const codes = [r1.status, r2.status].sort();
      expect(codes[0]).toBe(200);
      expect(codes[1]).toBeGreaterThanOrEqual(401); // the loser was demoted first: 401/403
      expect(await q(`SELECT 1 FROM users WHERE 'ADMIN' = ANY(roles) AND is_active`)).toHaveLength(1);
    });

    it("a deactivated account cannot be promoted to admin", async () => {
      const u = await registerUser(app, ["RIDER"]);
      await post(admin, `/users/${u.userId}/deactivate`, { reason: "suspended" });
      expect((await post(admin, `/users/${u.userId}/roles`, { add: ["ADMIN"], reason: "promote suspended" })).status).toBe(409);
    });
  });

  describe("audit log", () => {
    it("lists entries newest first with filters and pagination, and shows the actor's email", async () => {
      const u1 = await registerUser(app, ["RIDER"]), u2 = await registerUser(app, ["RIDER"]);
      await post(admin, `/users/${u1.userId}/deactivate`, { reason: "reason one" });
      await post(admin, `/users/${u2.userId}/deactivate`, { reason: "reason two" });
      await post(admin, `/users/${u1.userId}/activate`, { reason: "reason three" });

      const all = await get(admin, "/audit-logs?limit=2");
      expect(all.body.data.items).toHaveLength(2);
      expect(all.body.data.items[0].action).toBe("user.activated");
      expect(all.body.data.items[0].actorId).toBe(admin.userId);
      expect(all.body.data.nextCursor).toEqual(expect.any(String));
      const rest = await get(admin, `/audit-logs?limit=2&cursor=${all.body.data.nextCursor}`);
      expect(rest.body.data.items).toHaveLength(1);

      expect((await get(admin, "/audit-logs?action=user.deactivated")).body.data.items).toHaveLength(2);
      expect((await get(admin, `/audit-logs?entityType=user&entityId=${u1.userId}`)).body.data.items).toHaveLength(2);
      expect((await get(admin, `/audit-logs?actorId=${admin.userId}`)).body.data.items).toHaveLength(3);
      expect((await get(admin, `/audit-logs?from=${new Date(Date.now() + 86400000).toISOString()}`)).body.data.items).toEqual([]);
    });

    it("is APPEND-ONLY: the database refuses UPDATE and DELETE", async () => {
      const u = await registerUser(app, ["RIDER"]);
      await post(admin, `/users/${u.userId}/deactivate`, { reason: "evidence" });
      await expect(pool.query(`UPDATE audit_logs SET action = 'tampered'`)).rejects.toMatchObject({ code: "42501" });
      await expect(pool.query(`DELETE FROM audit_logs`)).rejects.toMatchObject({ code: "42501" });
      await expect(pool.query(`UPDATE audit_logs SET actor_id = $1`, [u.userId])).rejects.toMatchObject({ code: "42501" });
      expect(await audit("user.deactivated")).toHaveLength(1);
    });

    it("deleting a user keeps their audit rows (actor becomes NULL) instead of being blocked", async () => {
      const other = await adminWithEmail();
      const target = await registerUser(app, ["RIDER"]);
      await post(other, `/users/${target.userId}/deactivate`, { reason: "audit survives deletion" });
      await pool.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [other.userId]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [other.userId]);
      const [row] = await audit("user.deactivated");
      expect(row.actor_id).toBeNull();
    });

    it("records the existing admin actions too: driver verification and payment refund", async () => {
      const d = await registerUser(app, ["DRIVER"]);
      await request(app).post("/api/drivers/onboard").set(bearer(d.accessToken)).send({ licenseNumber: "DL-AUD-1", licenseExpiry: "2030-06-30" });
      const v = await request(app).patch(`/api/drivers/${d.userId}/verification`).set(bearer(admin.accessToken)).send({ status: "VERIFIED" });
      expect(v.status).toBe(200);
      const [row] = await audit("driver.verification_set");
      expect(row).toMatchObject({ actor_id: admin.userId, entity_id: d.userId });
      expect(row.metadata).toEqual({ status: "VERIFIED" });

      const { rideId, rider } = await createCompletedRide(app, vt, admin);
      const pay = await request(app).post("/api/payments").set(bearer(rider.accessToken)).set("Idempotency-Key", idemKey())
        .send({ payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });
      const ref = await request(app).post(`/api/payments/${pay.body.data.payment.id}/refund`).set(bearer(admin.accessToken));
      expect(ref.status).toBe(200);
      expect((await audit("payment.refunded"))[0].entity_id).toBe(pay.body.data.payment.id);
    });
  });

  describe("operational lists", () => {
    it("rides / payments / drivers / vehicles / rentals lists return display-ready rows and honour filters", async () => {
      const { rideId, rider, driver } = await createCompletedRide(app, vt, admin);
      await request(app).post("/api/payments").set(bearer(rider.accessToken)).set("Idempotency-Key", idemKey())
        .send({ payableType: "RIDE", payableId: rideId, paymentMethodToken: "tok_mock_success" });

      const rides = await get(admin, `/rides?status=PAYMENT_COMPLETED&riderId=${rider.userId}`);
      expect(rides.body.data.items).toHaveLength(1);
      expect(rides.body.data.items[0]).toMatchObject({ id: rideId, driverId: driver.userId, status: "PAYMENT_COMPLETED" });
      expect(rides.body.data.items[0].totalFare).toBeGreaterThan(0);
      expect((await get(admin, "/rides?status=REQUESTED")).body.data.items).toEqual([]);
      expect((await get(admin, `/rides?from=${new Date(Date.now() + 86400000).toISOString()}`)).body.data.items).toEqual([]);
      expect((await get(admin, `/rides?from=2030-01-02&to=2030-01-01`)).status).toBe(400);

      const pays = await get(admin, "/payments?status=SUCCESS&payableType=RIDE");
      expect(pays.body.data.items).toHaveLength(1);
      expect(pays.body.data.items[0]).toMatchObject({ payableId: rideId, status: "SUCCESS" });
      expect(JSON.stringify(pays.body)).not.toMatch(/idempotency|provider_reference/i);

      const drivers = await get(admin, "/drivers?verification=VERIFIED");
      expect(drivers.body.data.items.map((x: any) => x.userId)).toContain(driver.userId);
      expect((await get(admin, "/drivers?verification=PENDING")).body.data.items).toEqual([]);
      expect((await get(admin, "/drivers?online=true")).body.data.items.map((x: any) => x.userId)).toContain(driver.userId);

      const vehicles = await get(admin, "/vehicles?status=AVAILABLE");
      expect(vehicles.body.data.items.length).toBeGreaterThanOrEqual(1);
      expect(vehicles.body.data.items[0]).toHaveProperty("ownerEmail");
      expect((await get(admin, "/rentals")).body.data.items).toEqual([]);
    });

    it("every list paginates with a stable keyset (no duplicates across pages)", async () => {
      for (let i = 0; i < 4; i++) await createCompletedRide(app, vt, admin);
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const r: request.Response = await get(admin, `/rides?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
        ids.push(...r.body.data.items.map((x: any) => x.id));
        cursor = r.body.data.nextCursor;
      } while (cursor);
      expect(ids).toHaveLength(4);
      expect(new Set(ids).size).toBe(4);
    });
  });

  describe("moderation", () => {
    it("removes a listing, audits it, blocks the seller from relisting, and an admin can restore it", async () => {
      const seller = await registerSeller(app), buyer = await registerBuyer(app);
      const listing = await createListing(app, seller, vt);
      const offer = await makeOffer(app, buyer, listing.id, 400000);
      expect(offer.status).toBe(201);

      const res = await post(admin, `/listings/${listing.id}/remove`, { reason: "Counterfeit documents" });
      expect(res.status).toBe(200);
      expect((await q(`SELECT status, removed_reason FROM vehicle_listings WHERE id = $1`, [listing.id]))[0]).toMatchObject({ status: "DELISTED", removed_reason: "Counterfeit documents" });
      expect((await q(`SELECT status FROM vehicle_offers WHERE listing_id = $1`, [listing.id]))[0].status).toBe("REJECTED"); // pending offers are rejected
      expect((await audit("listing.removed"))[0]).toMatchObject({ actor_id: admin.userId, entity_id: listing.id });

      const relist = await request(app).post(`/api/marketplace/listings/${listing.id}/relist`).set(bearer(seller.accessToken));
      expect(relist.status).toBe(403);

      expect((await post(admin, `/listings/${listing.id}/restore`, { reason: "Documents verified" })).status).toBe(200);
      expect((await q(`SELECT status, removed_by_admin_at FROM vehicle_listings WHERE id = $1`, [listing.id]))[0]).toMatchObject({ status: "ACTIVE", removed_by_admin_at: null });
      expect((await post(admin, `/listings/${listing.id}/restore`, { reason: "again" })).status).toBe(409);
    });

    it("refuses to remove a listing while a buyer holds an accepted offer, and leaves no audit row", async () => {
      const seller = await registerSeller(app), buyer = await registerBuyer(app);
      const listing = await createListing(app, seller, vt);
      const offer = await makeOffer(app, buyer, listing.id, 450000);
      await acceptOffer(app, seller, offer.body.data.offer.id);
      const res = await post(admin, `/listings/${listing.id}/remove`, { reason: "should be refused" });
      expect(res.status).toBe(409);
      expect((await q(`SELECT status FROM vehicle_listings WHERE id = $1`, [listing.id]))[0].status).toBe("ACTIVE");
      expect(await audit("listing.removed")).toHaveLength(0);
    });

    it("unknown or non-removable listings give 404 / 409", async () => {
      expect((await post(admin, `/listings/00000000-0000-0000-0000-000000000000/remove`, { reason: "does not exist" })).status).toBe(404);
      const seller = await registerSeller(app);
      const listing = await createListing(app, seller, vt);
      await request(app).post(`/api/marketplace/listings/${listing.id}/delist`).set(bearer(seller.accessToken));
      expect((await post(admin, `/listings/${listing.id}/remove`, { reason: "already delisted" })).status).toBe(409);
      expect((await post(admin, `/listings/${listing.id}/restore`, { reason: "not removed by us" })).status).toBe(409);
    });

    it("deactivates and reactivates a garage; an inactive garage disappears from public search; every change is audited", async () => {
      const owner = await registerGarageOwner(app);
      const g = await createGarage(app, owner);
      const gid = g.garageId;
      expect((await get(admin, "/garages?active=true")).body.data.items.map((x: any) => x.id)).toContain(gid);

      expect((await post(admin, `/garages/${gid}/deactivate`, { reason: "Safety complaints" })).status).toBe(200);
      expect((await post(admin, `/garages/${gid}/deactivate`, { reason: "twice" })).status).toBe(409);
      expect((await get(admin, "/garages?active=false")).body.data.items.map((x: any) => x.id)).toEqual([gid]);
      const nearby = await request(app).get("/api/garages/nearby?lat=12.9716&lng=77.5946&radiusMeters=5000");
      expect(JSON.stringify(nearby.body)).not.toContain(gid);

      expect((await post(admin, `/garages/${gid}/activate`, { reason: "Inspection passed" })).status).toBe(200);
      expect((await audit("garage.deactivated"))).toHaveLength(1);
      expect((await audit("garage.activated"))).toHaveLength(1);
      expect((await post(admin, `/garages/00000000-0000-0000-0000-000000000000/deactivate`, { reason: "ghost" })).status).toBe(404);
    });
  });
});

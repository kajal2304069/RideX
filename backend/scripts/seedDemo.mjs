/**
 * Demo data, created THROUGH THE API (so every row passes the same validation and business rules real users hit).
 *   API_URL=http://localhost:4000 DATABASE_URL=... node scripts/seedDemo.mjs
 * Safe to re-run: it signs in to existing demo accounts and only creates what is missing.
 * All demo accounts use the password  Passw0rd123
 */
import pg from "pg";

const API = process.env.API_URL ?? "http://localhost:4000";
const PASSWORD = "Passw0rd123";
const CENTER = { lat: 12.9716, lng: 77.5946 };
const DEBUG = !!process.env.DEBUG;

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (DEBUG) console.log(method, path, res.status, JSON.stringify(json).slice(0, 700));
  return { status: res.status, data: json.data, error: json.error };
}
const must = (r, what) => {
  if (r.status >= 400) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.error)}`);
  return r.data;
};

async function account(email, fullName, roles) {
  let r = await call("POST", "/auth/register", { body: { email, password: PASSWORD, fullName, roles } });
  if (r.status === 409) r = await call("POST", "/auth/login", { body: { email, password: PASSWORD } });
  const d = must(r, `account ${email}`);
  return { id: d.user.id, token: d.accessToken, email };
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const admin0 = await account("admin@ridex.dev", "Asha Admin", ["RIDER"]);
await db.query(`UPDATE users SET roles = (SELECT array_agg(DISTINCT r) FROM unnest(roles || ARRAY['ADMIN']::user_role[]) r) WHERE id = $1`, [admin0.id]);
const admin = { ...admin0, token: must(await call("POST", "/auth/login", { body: { email: admin0.email, password: PASSWORD } }), "admin login").accessToken };

const rider = await account("rider@ridex.dev", "Ravi Rider", ["RIDER", "BUYER"]);
const driver = await account("driver@ridex.dev", "Divya Driver", ["DRIVER", "RIDER"]);
const owner = await account("owner@ridex.dev", "Omar Owner", ["VEHICLE_OWNER", "SELLER", "RIDER"]);
const garage = await account("garage@ridex.dev", "Gita Garage", ["GARAGE_OWNER"]);
const mechanic = await account("mechanic@ridex.dev", "Manoj Mechanic", ["MECHANIC"]);

const types = must(await call("GET", "/vehicles/types"), "types").vehicleTypes;
const type = (code) => types.find((t) => t.code === code)?.id;

// --- driver: onboard, verify, vehicle, assignment, go online ---
await call("POST", "/drivers/onboard", { token: driver.token, body: { licenseNumber: "KA-DL-2020-0001", licenseExpiry: "2032-06-30" } });
await call("PATCH", `/drivers/${driver.id}/verification`, { token: admin.token, body: { status: "VERIFIED" } });

let vehicles = must(await call("GET", "/vehicles/mine", { token: owner.token }), "vehicles").vehicles;
const ensureVehicle = async (reg, typeCode, brand, model, year, extra = {}) => {
  const found = vehicles.find((v) => v.registrationNumber === reg);
  if (found) return found;
  const v = must(await call("POST", "/vehicles", { token: owner.token, body: { vehicleTypeId: type(typeCode), registrationNumber: reg, brand, model, year, ...extra } }), `vehicle ${reg}`).vehicle;
  vehicles.push(v);
  return v;
};
const rideCar = await ensureVehicle("KA01AB1234", "SEDAN", "Toyota", "Etios", 2022, { color: "White", fuelType: "PETROL" });
const rentCars = [
  await ensureVehicle("KA05CD2345", "SEDAN", "Honda", "City", 2021, { color: "Silver", transmission: "AUTOMATIC" }),
  await ensureVehicle("KA03EF3456", "MINI", "Maruti", "Swift", 2020, { color: "Red" }),
  await ensureVehicle("KA02GH4567", "BIKE", "Royal Enfield", "Classic 350", 2023, { color: "Black" }),
];
if (!rideCar.currentDriverId) {
  await call("POST", `/vehicles/${rideCar.id}/assign-driver`, { token: owner.token, body: { driverId: driver.id, commissionPercent: 20, ownerSharePercent: 80 } });
}
await call("POST", "/drivers/online", { token: driver.token });
await call("POST", "/location/drivers/me", { token: driver.token, body: { lat: CENTER.lat + 0.004, lng: CENTER.lng + 0.003, heading: 90, speedKmh: 0 } });

// --- rental listings ---
const existingRentals = must(await call("GET", "/rentals/listings/mine", { token: owner.token }), "rentals").listings;
const rentalPlan = [
  [rentCars[0], { hourlyPrice: 180, dailyPrice: 1800, securityDeposit: 5000, address: "Indiranagar, Bangalore", rules: "No smoking. Return with the same fuel level." }, [0.012, 0.02]],
  [rentCars[1], { hourlyPrice: 120, dailyPrice: 1200, securityDeposit: 3000, address: "Koramangala, Bangalore", rules: "Licence and ID required at pickup." }, [-0.03, 0.025]],
  [rentCars[2], { hourlyPrice: 80, dailyPrice: 700, securityDeposit: 2000, address: "MG Road, Bangalore", rules: "Helmet provided. Max 200 km per day." }, [0.002, -0.004]],
];
for (const [v, body, [dLat, dLng]] of rentalPlan) {
  if (existingRentals.some((l) => l.vehicleId === v.id)) continue;
  must(await call("POST", "/rentals/listings", { token: owner.token, body: { vehicleId: v.id, ...body, lat: CENTER.lat + dLat, lng: CENTER.lng + dLng } }), "rental listing");
}

// --- garage ---
const myGarages = must(await call("GET", "/garages/mine", { token: garage.token }), "garages").garages ?? [];
if (!myGarages.length) {
  const g = must(await call("POST", "/garages", { token: garage.token, body: {
    name: "Sai Motors", lat: CENTER.lat + 0.006, lng: CENTER.lng - 0.004, address: "12 Residency Road, Bangalore", phone: "+918012345678",
    priceRange: "₹500 – ₹8,000", openingHours: { mon: "09:00-19:00", tue: "09:00-19:00", wed: "09:00-19:00", thu: "09:00-19:00", fri: "09:00-19:00", sat: "09:00-16:00" },
  } }), "garage").garage;
  for (const [serviceType, priceFrom, priceTo, mins] of [["OIL_CHANGE", 500, 1200, 45], ["BRAKE_REPAIR", 1500, 5000, 120], ["GENERAL_SERVICE", 2500, 6000, 240], ["TYRE_REPLACEMENT", 800, 9000, 60], ["EMERGENCY_REPAIR", 800, 8000, 60]]) {
    await call("POST", `/garages/${g.id}/services`, { token: garage.token, body: { serviceType, priceFrom, priceTo, estimatedDurationMinutes: mins } });
  }
  await call("POST", `/garages/${g.id}/mechanics`, { token: garage.token, body: { name: "Manoj Mechanic", specialization: "Engines", userId: mechanic.id } });
}

// --- marketplace listings ---
const mine = must(await call("GET", "/marketplace/listings/mine", { token: owner.token }), "my listings");
const listings = mine.listings ?? mine.items ?? [];
if (!listings.length) {
  const plan = [
    ["SEDAN", "Hyundai", "Verna", 2019, 48000, "PETROL", "MANUAL", "GOOD", 1, 585000, "Whitefield, Bangalore", "Single owner, full service history, new tyres."],
    ["MINI", "Maruti", "Alto K10", 2021, 21000, "PETROL", "MANUAL", "EXCELLENT", 1, 340000, "Jayanagar, Bangalore", "Garage kept. Insurance valid."],
    ["BIKE", "Bajaj", "Pulsar 150", 2020, 18500, "PETROL", "MANUAL", "FAIR", 2, 68000, "HSR Layout, Bangalore", "Minor scratches, engine in great shape."],
    ["SEDAN", "Tata", "Tigor EV", 2022, 15000, "ELECTRIC", "AUTOMATIC", "EXCELLENT", 1, 790000, "Electronic City, Bangalore", "Battery health 94%. Home charger included."],
  ];
  for (const [t, brand, model, year, mileageKm, fuelType, transmission, condition, ownerCount, price, address, description] of plan) {
    const l = must(await call("POST", "/marketplace/listings", { token: owner.token, body: {
      vehicleTypeId: type(t), brand, model, year, mileageKm, fuelType, transmission, condition, ownerCount, price,
      lat: CENTER.lat + (Math.random() - 0.5) * 0.08, lng: CENTER.lng + (Math.random() - 0.5) * 0.08, address, description, insuranceValidUntil: "2027-03-31",
    } }), "listing").listing;
    await call("POST", `/marketplace/listings/${l.id}/images`, { token: owner.token, body: { url: `https://picsum.photos/seed/${model.replace(/\W/g, "")}/800/500`, position: 0 } });
  }
}

await db.end();
console.log(`Demo data ready.\n  admin@ridex.dev  rider@ridex.dev  driver@ridex.dev  owner@ridex.dev  garage@ridex.dev  mechanic@ridex.dev\n  password: ${PASSWORD}`);

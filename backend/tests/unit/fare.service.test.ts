import { haversineDistanceMeters, estimateDurationSeconds, computeFare } from "../../src/modules/rides/services/fare.service";

describe("haversineDistanceMeters", () => {
  it("returns ~0 for the same point", () => {
    const p = { lat: 12.9716, lng: 77.5946 };
    expect(haversineDistanceMeters(p, p)).toBeLessThan(1);
  });

  it("returns a known real-world distance within reasonable tolerance", () => {
    // MG Road, Bangalore -> Bangalore Airport, roughly 35km as the crow flies
    const mgRoad = { lat: 12.9716, lng: 77.5946 };
    const airport = { lat: 13.1986, lng: 77.7066 };
    const distance = haversineDistanceMeters(mgRoad, airport);
    expect(distance).toBeGreaterThan(25000);
    expect(distance).toBeLessThan(45000);
  });

  it("is symmetric: distance(a,b) === distance(b,a)", () => {
    const a = { lat: 12.9716, lng: 77.5946 };
    const b = { lat: 13.0, lng: 77.6 };
    expect(haversineDistanceMeters(a, b)).toBeCloseTo(haversineDistanceMeters(b, a), 5);
  });
});

describe("estimateDurationSeconds", () => {
  it("scales linearly with distance", () => {
    const short = estimateDurationSeconds(1000);
    const long = estimateDurationSeconds(10000);
    expect(long).toBeCloseTo(short * 10, 0);
  });
});

describe("computeFare", () => {
  const sedanRates = { baseFare: 50, perKmRate: 13, perMinRate: 1.5 };

  it("computes a correct breakdown for a simple trip with no surge/discount", () => {
    // 5km, 12 minutes
    const fare = computeFare(5000, 720, sedanRates);

    expect(fare.baseFare).toBe(50);
    expect(fare.distanceCharge).toBe(65); // 5km * 13
    expect(fare.timeCharge).toBe(18); // 12min * 1.5
    expect(fare.bookingFee).toBe(5);
    expect(fare.surgeMultiplier).toBe(1.0);
    expect(fare.discount).toBe(0);
    // subtotal = 50+65+18+5 = 138, tax = 5% of 138 = 6.9, total = 144.9
    expect(fare.tax).toBeCloseTo(6.9, 2);
    expect(fare.totalFare).toBeCloseTo(144.9, 2);
  });

  it("applies the surge multiplier to the pre-tax subtotal", () => {
    const noSurge = computeFare(5000, 720, sedanRates);
    const surged = computeFare(5000, 720, sedanRates, { surgeMultiplier: 2.0 });

    // Surged total should be greater, and specifically the multiplier
    // applies before tax (tax is a percentage of the surged amount).
    expect(surged.totalFare).toBeGreaterThan(noSurge.totalFare * 1.9);
  });

  it("applies a discount before tax, never producing a negative subtotal", () => {
    const fare = computeFare(1000, 120, sedanRates, { discount: 10000 }); // absurdly large discount
    expect(fare.totalFare).toBeGreaterThanOrEqual(0);
    expect(fare.discount).toBe(10000);
  });

  it("always includes the flat booking fee regardless of trip length", () => {
    const shortTrip = computeFare(100, 30, sedanRates);
    const longTrip = computeFare(50000, 3600, sedanRates);
    expect(shortTrip.bookingFee).toBe(5);
    expect(longTrip.bookingFee).toBe(5);
  });

  it("scales distance and time charges independently by their own rates", () => {
    const bikeRates = { baseFare: 20, perKmRate: 6, perMinRate: 0.5 };
    const bikeFare = computeFare(5000, 720, bikeRates);
    const sedanFare = computeFare(5000, 720, sedanRates);

    expect(bikeFare.distanceCharge).toBeLessThan(sedanFare.distanceCharge);
    expect(bikeFare.timeCharge).toBeLessThan(sedanFare.timeCharge);
  });
});

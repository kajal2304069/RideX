import { Page, Where, keysetPage, likePattern } from "./pagination";

type Common = { limit: number; cursor?: string };
const rangeOn = (w: Where, col: string, from?: Date, to?: Date) => {
  if (from) w.add((p) => `${col} >= ${p(from)}`);
  if (to) w.add((p) => `${col} < ${p(to)}`);
};
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * Read-only operational lists for the admin console. Each row is a flat, display-ready summary (joins already done) so
 * the UI needs one call per table. Money columns are converted to numbers here; no secret columns are ever selected.
 */
export const adminListsRepository = {
  async drivers(f: Common & { verification?: string; online?: boolean; q?: string }): Promise<Page<unknown>> {
    const w = new Where();
    if (f.verification) w.add((p) => `a.verification_status = ${p(f.verification)}::verification_status`);
    if (f.online !== undefined) w.add((p) => `a.is_online = ${p(f.online)}`);
    if (f.q) w.add((p) => { const v = p(likePattern(f.q!)); return `(u.email ILIKE ${v} OR u.full_name ILIKE ${v} OR a.license_number ILIKE ${v})`; });
    return keysetPage(
      `a.user_id, u.email, u.full_name, u.is_active, a.license_number, a.license_expiry, a.verification_status, a.is_online, a.current_vehicle_id, a.rating_avg, a.total_rides, a.created_at`,
      `FROM (SELECT d.*, d.user_id AS id FROM drivers d) a JOIN users u ON u.id = a.user_id`, w, f.limit, f.cursor,
      // keyset pagination needs an `id` column; drivers are keyed by user_id, so it is aliased in the subquery
      (r) => ({ userId: r.user_id, email: r.email, fullName: r.full_name, accountActive: r.is_active, licenseNumber: r.license_number, licenseExpiry: r.license_expiry,
        verificationStatus: r.verification_status, isOnline: r.is_online, currentVehicleId: r.current_vehicle_id, rating: num(r.rating_avg), totalRides: r.total_rides, createdAt: r.created_at })
    );
  },

  async vehicles(f: Common & { status?: string; ownerId?: string; q?: string }): Promise<Page<unknown>> {
    const w = new Where();
    if (f.status) w.add((p) => `a.status = ${p(f.status)}::vehicle_status`);
    if (f.ownerId) w.add((p) => `a.owner_id = ${p(f.ownerId)}`);
    if (f.q) w.add((p) => { const v = p(likePattern(f.q!)); return `(a.registration_number ILIKE ${v} OR a.brand ILIKE ${v} OR a.model ILIKE ${v})`; });
    return keysetPage(
      `a.id, a.registration_number, a.brand, a.model, a.year, a.status, a.owner_id, o.email AS owner_email, a.current_driver_id, t.code AS type_code, a.created_at`,
      `FROM vehicles a JOIN users o ON o.id = a.owner_id JOIN vehicle_types t ON t.id = a.vehicle_type_id`, w, f.limit, f.cursor,
      (r) => ({ id: r.id, registrationNumber: r.registration_number, brand: r.brand, model: r.model, year: r.year, status: r.status, typeCode: r.type_code,
        ownerId: r.owner_id, ownerEmail: r.owner_email, currentDriverId: r.current_driver_id, createdAt: r.created_at })
    );
  },

  async rides(f: Common & { status?: string; riderId?: string; driverId?: string; from?: Date; to?: Date }): Promise<Page<unknown>> {
    const w = new Where();
    if (f.status) w.add((p) => `a.status = ${p(f.status)}::ride_status`);
    if (f.riderId) w.add((p) => `a.rider_id = ${p(f.riderId)}`);
    if (f.driverId) w.add((p) => `a.driver_id = ${p(f.driverId)}`);
    rangeOn(w, "a.created_at", f.from, f.to);
    return keysetPage(
      `a.id, a.status, a.rider_id, a.driver_id, a.vehicle_id, a.pickup_address, a.dropoff_address, a.distance_meters, a.duration_seconds,
       f.total_fare, a.requested_at, a.accepted_at, a.completed_at, a.cancellation_reason, a.created_at`,
      `FROM rides a LEFT JOIN ride_fares f ON f.ride_id = a.id`, w, f.limit, f.cursor,
      (r) => ({ id: r.id, status: r.status, riderId: r.rider_id, driverId: r.driver_id, vehicleId: r.vehicle_id, pickupAddress: r.pickup_address, dropoffAddress: r.dropoff_address,
        distanceMeters: r.distance_meters, durationSeconds: r.duration_seconds, totalFare: num(r.total_fare), requestedAt: r.requested_at, acceptedAt: r.accepted_at,
        completedAt: r.completed_at, cancellationReason: r.cancellation_reason, createdAt: r.created_at })
    );
  },

  async rentals(f: Common & { status?: string; renterId?: string; ownerId?: string; from?: Date; to?: Date }): Promise<Page<unknown>> {
    const w = new Where();
    if (f.status) w.add((p) => `a.status = ${p(f.status)}::rental_booking_status`);
    if (f.renterId) w.add((p) => `a.renter_id = ${p(f.renterId)}`);
    if (f.ownerId) w.add((p) => `l.owner_id = ${p(f.ownerId)}`);
    rangeOn(w, "a.created_at", f.from, f.to);
    return keysetPage(
      `a.id, a.status, a.renter_id, l.owner_id, l.vehicle_id, a.start_at, a.end_at, a.actual_return_at, a.total_amount, a.deposit_amount, a.late_fee, a.damage_deduction, a.refund_amount, a.created_at`,
      `FROM rental_bookings a JOIN rental_listings l ON l.id = a.rental_listing_id`, w, f.limit, f.cursor,
      (r) => ({ id: r.id, status: r.status, renterId: r.renter_id, ownerId: r.owner_id, vehicleId: r.vehicle_id, startAt: r.start_at, endAt: r.end_at, returnedAt: r.actual_return_at,
        rentAmount: num(r.total_amount), depositAmount: num(r.deposit_amount), lateFee: num(r.late_fee), damageDeduction: num(r.damage_deduction), refundAmount: num(r.refund_amount), createdAt: r.created_at })
    );
  },

  async listings(f: Common & { status?: string; sellerId?: string; q?: string }): Promise<Page<unknown>> {
    const w = new Where();
    if (f.status) w.add((p) => `a.status = ${p(f.status)}::listing_status`);
    if (f.sellerId) w.add((p) => `a.seller_id = ${p(f.sellerId)}`);
    if (f.q) w.add((p) => { const v = p(likePattern(f.q!)); return `(a.brand ILIKE ${v} OR a.model ILIKE ${v})`; });
    return keysetPage(
      `a.id, a.seller_id, a.brand, a.model, a.year, a.price, a.status, a.condition, a.address, a.created_at`,
      `FROM vehicle_listings a`, w, f.limit, f.cursor,
      (r) => ({ id: r.id, sellerId: r.seller_id, brand: r.brand, model: r.model, year: r.year, price: num(r.price), status: r.status, condition: r.condition, address: r.address, createdAt: r.created_at })
    );
  },

  async garages(f: Common & { active?: boolean; q?: string }): Promise<Page<unknown>> {
    const w = new Where();
    if (f.active !== undefined) w.add((p) => `a.is_active = ${p(f.active)}`);
    if (f.q) w.add((p) => { const v = p(likePattern(f.q!)); return `(a.name ILIKE ${v} OR a.address ILIKE ${v})`; });
    return keysetPage(
      `a.id, a.name, a.owner_id, a.address, a.phone, a.rating_avg, a.is_active, a.created_at,
       (SELECT COUNT(*) FROM service_bookings b WHERE b.garage_id = a.id) AS bookings`,
      `FROM garages a`, w, f.limit, f.cursor,
      (r) => ({ id: r.id, name: r.name, ownerId: r.owner_id, address: r.address, phone: r.phone, rating: num(r.rating_avg), isActive: r.is_active, bookings: Number(r.bookings), createdAt: r.created_at })
    );
  },

  async payments(f: Common & { status?: string; payableType?: string; payerId?: string; from?: Date; to?: Date }): Promise<Page<unknown>> {
    const w = new Where();
    if (f.status) w.add((p) => `a.status = ${p(f.status)}::payment_status`);
    if (f.payableType) w.add((p) => `a.payable_type = ${p(f.payableType)}::payable_type`);
    if (f.payerId) w.add((p) => `a.payer_id = ${p(f.payerId)}`);
    rangeOn(w, "a.created_at", f.from, f.to);
    return keysetPage(
      `a.id, a.payable_type, a.payable_id, a.payer_id, a.amount, a.currency, a.provider, a.status, a.failure_reason, a.created_at, a.updated_at`,
      `FROM payments a`, w, f.limit, f.cursor,
      (r) => ({ id: r.id, payableType: r.payable_type, payableId: r.payable_id, payerId: r.payer_id, amount: num(r.amount), currency: r.currency, provider: r.provider,
        status: r.status, failureReason: r.failure_reason, createdAt: r.created_at, updatedAt: r.updated_at })
    );
  },
};

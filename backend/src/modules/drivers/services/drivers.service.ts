import { ApiError } from "../../../common/ApiError";
import { logger } from "../../../config/logger";
import { driversRepository } from "../repositories/drivers.repository";
import { locationService } from "../../location/services/location.service";
import { emitToRoom, userRoom } from "../../../websocket/io";
import { PublicDriverProfile, toPublicDriverProfile } from "../types/drivers.types";

export const driversService = {
  /**
   * A DRIVER-role user has no `drivers` row until they complete this
   * onboarding step - unlike RIDER, which is auto-provisioned at
   * registration (see auth.repository.createUser), because a driver
   * profile needs license info that registration doesn't collect. New
   * drivers start PENDING and can't go online until an admin verifies
   * them (spec section 18's verification workflow applied to drivers).
   */
  async onboard(
    userId: string,
    input: { licenseNumber: string; licenseExpiry: string }
  ): Promise<PublicDriverProfile> {
    const existing = await driversRepository.findByUserId(userId);
    if (existing) {
      throw ApiError.conflict("Driver profile already exists for this user");
    }

    const expiryDate = new Date(input.licenseExpiry);
    if (Number.isNaN(expiryDate.getTime()) || expiryDate <= new Date()) {
      throw ApiError.badRequest("License expiry must be a valid, future date");
    }

    const licenseTaken = await driversRepository.findByLicenseNumber(input.licenseNumber);
    if (licenseTaken) {
      throw ApiError.conflict("This license number is already registered");
    }

    const driver = await driversRepository.create({
      userId,
      licenseNumber: input.licenseNumber,
      licenseExpiry: input.licenseExpiry,
    });
    logger.info({ userId }, "Driver onboarded, pending verification");
    return toPublicDriverProfile(driver);
  },

  async getMyProfile(userId: string): Promise<PublicDriverProfile> {
    const driver = await driversRepository.findByUserId(userId);
    if (!driver) {
      throw ApiError.notFound("Driver profile not found - complete onboarding first");
    }
    return toPublicDriverProfile(driver);
  },

  /**
   * A driver can only go online once VERIFIED - an unverified or
   * rejected driver being dispatchable would defeat the entire point of
   * having a verification step. This is exactly the kind of rule that
   * belongs in the service layer (not the DB, not the controller) per
   * the Phase 1 layering rules: it's a business rule, testable in
   * isolation without a real database (see drivers.service.test.ts).
   */
  async goOnline(userId: string): Promise<PublicDriverProfile> {
    const driver = await driversRepository.findByUserId(userId);
    if (!driver) throw ApiError.notFound("Driver profile not found - complete onboarding first");

    if (driver.verification_status !== "VERIFIED") {
      throw ApiError.forbidden(
        `Cannot go online: driver verification status is ${driver.verification_status}`
      );
    }

    const updated = await driversRepository.setOnlineStatus(userId, true);
    const profile = toPublicDriverProfile(updated!);
    emitToRoom(userRoom(userId), "driver:online", profile);
    return profile;
  },

  async goOffline(userId: string): Promise<PublicDriverProfile> {
    const driver = await driversRepository.findByUserId(userId);
    if (!driver) throw ApiError.notFound("Driver profile not found - complete onboarding first");

    const updated = await driversRepository.setOnlineStatus(userId, false);
    // Going offline must remove the driver from live nearby-search results
    // immediately - relying solely on the location hash's TTL (Phase 7)
    // would leave them visible for up to 2 more minutes after they
    // explicitly said they're done for the day.
    await locationService.removeDriverLocation(userId);
    const profile = toPublicDriverProfile(updated!);
    emitToRoom(userRoom(userId), "driver:offline", profile);
    return profile;
  },

  /** Admin-only: approve or reject a driver's verification (spec section 18 workflow, applied here to drivers). */
  async setVerification(
    driverId: string,
    status: "VERIFIED" | "REJECTED",
    adminId: string
  ): Promise<PublicDriverProfile> {
    const driver = await driversRepository.findByUserId(driverId);
    if (!driver) throw ApiError.notFound("Driver not found");

    const updated = await driversRepository.setVerificationStatus(driverId, status);
    logger.info({ driverId, status, adminId }, "Driver verification status changed");
    return toPublicDriverProfile(updated!);
  },

  async listPendingVerification(): Promise<PublicDriverProfile[]> {
    const drivers = await driversRepository.listPendingVerification();
    return drivers.map(toPublicDriverProfile);
  },
};

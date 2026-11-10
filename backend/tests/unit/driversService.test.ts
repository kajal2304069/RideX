import { driversService } from "../../src/modules/drivers/services/drivers.service";
import { driversRepository } from "../../src/modules/drivers/repositories/drivers.repository";
import { locationService } from "../../src/modules/location/services/location.service";
import { ApiError } from "../../src/common/ApiError";
import { DriverRecord } from "../../src/modules/drivers/types/drivers.types";

jest.mock("../../src/modules/drivers/repositories/drivers.repository");
jest.mock("../../src/modules/location/services/location.service");

const mockedRepo = driversRepository as jest.Mocked<typeof driversRepository>;
const mockedLocationService = locationService as jest.Mocked<typeof locationService>;

function fakeDriver(overrides: Partial<DriverRecord> = {}): DriverRecord {
  return {
    user_id: "driver-1",
    license_number: "DL-123",
    license_expiry: "2030-01-01",
    verification_status: "PENDING",
    is_online: false,
    current_vehicle_id: null,
    rating_avg: "5.00",
    total_rides: 0,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe("driversService (unit, mocked repository)", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("onboard", () => {
    it("rejects onboarding a user who already has a driver profile", async () => {
      mockedRepo.findByUserId.mockResolvedValue(fakeDriver());

      await expect(
        driversService.onboard("driver-1", { licenseNumber: "DL-999", licenseExpiry: "2030-01-01" })
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("rejects a license expiry date in the past", async () => {
      mockedRepo.findByUserId.mockResolvedValue(null);

      await expect(
        driversService.onboard("driver-1", { licenseNumber: "DL-999", licenseExpiry: "2000-01-01" })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects a license number already registered to someone else", async () => {
      mockedRepo.findByUserId.mockResolvedValue(null);
      mockedRepo.findByLicenseNumber.mockResolvedValue(fakeDriver({ user_id: "someone-else" }));

      await expect(
        driversService.onboard("driver-1", { licenseNumber: "DL-123", licenseExpiry: "2030-01-01" })
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("creates a driver profile with PENDING verification when inputs are valid", async () => {
      mockedRepo.findByUserId.mockResolvedValue(null);
      mockedRepo.findByLicenseNumber.mockResolvedValue(null);
      mockedRepo.create.mockResolvedValue(fakeDriver());

      const result = await driversService.onboard("driver-1", {
        licenseNumber: "DL-123",
        licenseExpiry: "2030-01-01",
      });

      expect(result.verificationStatus).toBe("PENDING");
      expect(mockedRepo.create).toHaveBeenCalledWith({
        userId: "driver-1",
        licenseNumber: "DL-123",
        licenseExpiry: "2030-01-01",
      });
    });
  });

  describe("goOnline", () => {
    it("rejects going online when verification_status is PENDING", async () => {
      mockedRepo.findByUserId.mockResolvedValue(fakeDriver({ verification_status: "PENDING" }));

      await expect(driversService.goOnline("driver-1")).rejects.toMatchObject({ statusCode: 403 });
      expect(mockedRepo.setOnlineStatus).not.toHaveBeenCalled();
    });

    it("rejects going online when verification_status is REJECTED", async () => {
      mockedRepo.findByUserId.mockResolvedValue(fakeDriver({ verification_status: "REJECTED" }));

      await expect(driversService.goOnline("driver-1")).rejects.toMatchObject({ statusCode: 403 });
    });

    it("allows going online when verification_status is VERIFIED", async () => {
      mockedRepo.findByUserId.mockResolvedValue(fakeDriver({ verification_status: "VERIFIED" }));
      mockedRepo.setOnlineStatus.mockResolvedValue(
        fakeDriver({ verification_status: "VERIFIED", is_online: true })
      );

      const result = await driversService.goOnline("driver-1");
      expect(result.isOnline).toBe(true);
      expect(mockedRepo.setOnlineStatus).toHaveBeenCalledWith("driver-1", true);
    });

    it("throws 404 for a user with no driver profile at all", async () => {
      mockedRepo.findByUserId.mockResolvedValue(null);
      await expect(driversService.goOnline("nobody")).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe("goOffline", () => {
    it("always allowed regardless of verification status, and clears live location presence", async () => {
      mockedRepo.findByUserId.mockResolvedValue(fakeDriver({ verification_status: "PENDING", is_online: true }));
      mockedRepo.setOnlineStatus.mockResolvedValue(fakeDriver({ is_online: false }));
      mockedLocationService.removeDriverLocation.mockResolvedValue(undefined);

      const result = await driversService.goOffline("driver-1");
      expect(result.isOnline).toBe(false);
      expect(mockedLocationService.removeDriverLocation).toHaveBeenCalledWith("driver-1");
    });
  });
});

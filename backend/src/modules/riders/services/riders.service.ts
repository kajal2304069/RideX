import { ApiError } from "../../../common/ApiError";
import { ridersRepository } from "../repositories/riders.repository";
import { toPublicRiderProfile, PublicRiderProfile } from "../types/riders.types";

export const ridersService = {
  async getMyProfile(userId: string): Promise<PublicRiderProfile> {
    const rider = await ridersRepository.findByUserId(userId);
    if (!rider) {
      // Should be unreachable for a user with the RIDER role, since
      // auth.repository.createUser provisions this row atomically at
      // registration - surfacing as a 404 (not a 500) if it ever does
      // happen, since it points at a data problem, not a server crash.
      throw ApiError.notFound("Rider profile not found");
    }
    return toPublicRiderProfile(rider);
  },
};

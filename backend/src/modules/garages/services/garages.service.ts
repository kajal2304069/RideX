import { ApiError } from "../../../common/ApiError";
import { garagesRepository } from "../repositories/garages.repository";
import {
  GarageRecord, GarageServiceType, PublicGarage, toPublicGarage, toPublicMechanic, toPublicService,
} from "../types/garages.types";

function isUniqueViolation(err: unknown): err is { code: "23505" } {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export interface CreateGarageInput {
  name: string;
  lat: number;
  lng: number;
  address: string;
  phone?: string;
  openingHours?: Record<string, string>;
  priceRange?: string;
}

/** Loads a garage and proves the caller owns it. 404 (not 403) for non-owners so existence isn't leaked. */
async function loadOwnedGarage(garageId: string, userId: string, isAdmin = false): Promise<GarageRecord> {
  const garage = await garagesRepository.findById(garageId);
  if (!garage || (garage.owner_id !== userId && !isAdmin)) throw ApiError.notFound("Garage not found");
  return garage;
}

export const garagesService = {
  async create(ownerId: string, input: CreateGarageInput): Promise<PublicGarage> {
    return toPublicGarage(await garagesRepository.create({ ownerId, ...input }));
  },

  async listMine(ownerId: string): Promise<PublicGarage[]> {
    return (await garagesRepository.findByOwner(ownerId)).map(toPublicGarage);
  },

  /** Public detail: only ACTIVE garages are visible to the public; owners/admins can see their own inactive ones. */
  async getOne(garageId: string, viewerId?: string, isAdmin = false) {
    const garage = await garagesRepository.findById(garageId);
    if (!garage || (!garage.is_active && garage.owner_id !== viewerId && !isAdmin)) throw ApiError.notFound("Garage not found");
    const [services, mechanics] = await Promise.all([
      garagesRepository.listServices(garageId),
      // Mechanic roster is operational data: owner/admin only.
      garage.owner_id === viewerId || isAdmin ? garagesRepository.listMechanics(garageId) : Promise.resolve([]),
    ]);
    return { garage: toPublicGarage(garage), services: services.map(toPublicService), mechanics: mechanics.map(toPublicMechanic) };
  },

  async update(garageId: string, userId: string, patch: Parameters<typeof garagesRepository.update>[1]): Promise<PublicGarage> {
    await loadOwnedGarage(garageId, userId);
    return toPublicGarage((await garagesRepository.update(garageId, patch))!);
  },

  async nearby(input: { lat: number; lng: number; radiusMeters: number; serviceType?: GarageServiceType; limit: number }): Promise<PublicGarage[]> {
    return (await garagesRepository.findNearby(input)).map(toPublicGarage);
  },

  async addService(garageId: string, userId: string, input: Parameters<typeof garagesRepository.addService>[1]) {
    await loadOwnedGarage(garageId, userId);
    if (input.priceFrom !== undefined && input.priceTo !== undefined && input.priceFrom > input.priceTo) {
      throw ApiError.badRequest("priceFrom cannot exceed priceTo");
    }
    try {
      return toPublicService(await garagesRepository.addService(garageId, input));
    } catch (err) {
      if (isUniqueViolation(err)) throw ApiError.conflict(`This garage already offers ${input.serviceType}`);
      throw err;
    }
  },

  async removeService(garageId: string, userId: string, serviceId: string): Promise<void> {
    await loadOwnedGarage(garageId, userId);
    if (!(await garagesRepository.deleteService(garageId, serviceId))) throw ApiError.notFound("Service not found");
  },

  async addMechanic(garageId: string, userId: string, input: { name: string; specialization?: string; userId?: string }) {
    await loadOwnedGarage(garageId, userId);
    return toPublicMechanic(await garagesRepository.addMechanic(garageId, input));
  },

  async listMechanics(garageId: string, userId: string, isAdmin: boolean) {
    await loadOwnedGarage(garageId, userId, isAdmin);
    return (await garagesRepository.listMechanics(garageId)).map(toPublicMechanic);
  },

  async setMechanicActive(garageId: string, userId: string, mechanicId: string, active: boolean) {
    await loadOwnedGarage(garageId, userId);
    const mechanic = await garagesRepository.findMechanic(mechanicId);
    if (!mechanic || mechanic.garage_id !== garageId) throw ApiError.notFound("Mechanic not found");
    if (!active && (await garagesRepository.mechanicHasActiveJob(mechanicId))) {
      throw ApiError.conflict("Mechanic has an active job; finish or reassign it first");
    }
    return toPublicMechanic((await garagesRepository.setMechanicActive(mechanicId, active))!);
  },
};

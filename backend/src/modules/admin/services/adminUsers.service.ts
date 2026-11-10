import { ApiError } from "../../../common/ApiError";
import { markDeactivated, clearDeactivated, invalidateTokensIssuedBefore } from "../../../common/tokenRevocation";
import { logger } from "../../../config/logger";
import { withTransaction } from "../../../db/pool";
import { earningsRepository } from "../../earnings/repositories/earnings.repository";
import { locationService } from "../../location/services/location.service";
import { getIO, userRoom } from "../../../websocket/io";
import { adminUsersRepository, LockedUser } from "../repositories/adminUsers.repository";
import { auditService } from "./audit.service";

export const ALL_ROLES = ["RIDER", "DRIVER", "VEHICLE_OWNER", "GARAGE_OWNER", "MECHANIC", "SELLER", "BUYER", "ADMIN"] as const;
type Role = (typeof ALL_ROLES)[number];

export interface Actor { id: string; ip?: string }

/** Pure rule, exported for unit tests: would this change leave at least one ACTIVE admin? */
export function adminsRemainAfter(admins: LockedUser[], targetId: string, stillAdminAndActive: boolean): boolean {
  return admins.filter((a) => (a.id === targetId ? stillAdminAndActive : a.is_active)).length >= 1;
}

/** The acting admin must STILL be an active admin when the lock is held (they may have been demoted a moment ago). */
function assertActorStillAdmin(admins: LockedUser[], actorId: string) {
  const me = admins.find((a) => a.id === actorId);
  if (!me || !me.is_active) throw ApiError.forbidden("You no longer have admin access");
}

export const adminUsersService = {
  list: (f: Parameters<typeof adminUsersRepository.list>[0]) => adminUsersRepository.list(f),

  async get(id: string) {
    const user = await adminUsersRepository.findById(id);
    if (!user) throw ApiError.notFound("User not found");
    const [activity, balance] = await Promise.all([adminUsersRepository.activity(id), earningsRepository.balance(id)]);
    return { user, activity, balance };
  },

  async deactivate(actor: Actor, targetId: string, reason: string) {
    if (actor.id === targetId) throw ApiError.badRequest("You cannot deactivate your own account");

    await withTransaction(async (client) => {
      const admins = await adminUsersRepository.lockAdmins(client);
      assertActorStillAdmin(admins, actor.id);
      const target = await adminUsersRepository.lockUser(client, targetId);
      if (!target) throw ApiError.notFound("User not found");
      if (!target.is_active) throw ApiError.conflict("This account is already deactivated");
      if (target.roles.includes("ADMIN") && !adminsRemainAfter(admins, targetId, false)) {
        throw ApiError.conflict("Cannot deactivate the last active admin");
      }
      await adminUsersRepository.deactivate(client, targetId, reason);
      await auditService.record({ actorId: actor.id, action: "user.deactivated", entityType: "user", entityId: targetId, metadata: { reason }, ip: actor.ip }, client);
    });

    // After commit: make it take effect NOW rather than when the access token expires.
    try {
      await markDeactivated(targetId);
      await locationService.removeDriverLocation(targetId);
      getIO()?.in(userRoom(targetId)).disconnectSockets(true);
    } catch (err) {
      logger.error({ err, targetId }, "Deactivated user, but instant-revocation side effects failed (token lives <= 15 min)");
    }
    return this.get(targetId);
  },

  async activate(actor: Actor, targetId: string, reason: string) {
    await withTransaction(async (client) => {
      const admins = await adminUsersRepository.lockAdmins(client);
      assertActorStillAdmin(admins, actor.id);
      const target = await adminUsersRepository.lockUser(client, targetId);
      if (!target) throw ApiError.notFound("User not found");
      if (target.is_active) throw ApiError.conflict("This account is already active");
      await adminUsersRepository.activate(client, targetId);
      await auditService.record({ actorId: actor.id, action: "user.activated", entityType: "user", entityId: targetId, metadata: { reason }, ip: actor.ip }, client);
    });
    try { await clearDeactivated(targetId); } catch (err) { logger.error({ err, targetId }, "Could not clear deactivation marker"); }
    return this.get(targetId);
  },

  /**
   * Grants and/or revokes roles. Rules: roles are never empty; you cannot change your own ADMIN role; the last active
   * admin can never be removed; only active accounts can become admins. The target's existing access tokens are
   * invalidated so the new roles apply on their next refresh.
   */
  async changeRoles(actor: Actor, targetId: string, input: { add: Role[]; remove: Role[]; reason: string }) {
    const overlap = input.add.filter((r) => input.remove.includes(r));
    if (overlap.length) throw ApiError.badRequest(`A role cannot be both added and removed: ${overlap.join(", ")}`);

    const result = await withTransaction(async (client) => {
      const admins = await adminUsersRepository.lockAdmins(client);
      assertActorStillAdmin(admins, actor.id);
      const target = await adminUsersRepository.lockUser(client, targetId);
      if (!target) throw ApiError.notFound("User not found");

      const before = target.roles as Role[];
      const after = [...new Set([...before, ...input.add])].filter((r) => !input.remove.includes(r)) as Role[];
      if (after.length === 0) throw ApiError.badRequest("A user must keep at least one role");
      if (before.length === after.length && before.every((r) => after.includes(r))) return { changed: false as const, before, after };

      const losesAdmin = before.includes("ADMIN") && !after.includes("ADMIN");
      const gainsAdmin = !before.includes("ADMIN") && after.includes("ADMIN");
      if ((losesAdmin || gainsAdmin) && actor.id === targetId) throw ApiError.badRequest("You cannot change your own admin role");
      if (gainsAdmin && !target.is_active) throw ApiError.conflict("A deactivated account cannot be made an admin");
      if (losesAdmin && !adminsRemainAfter(admins, targetId, false)) throw ApiError.conflict("Cannot remove the last active admin");

      await adminUsersRepository.setRoles(client, targetId, after);
      await auditService.record(
        { actorId: actor.id, action: "user.roles_changed", entityType: "user", entityId: targetId, metadata: { before, after, reason: input.reason }, ip: actor.ip },
        client
      );
      return { changed: true as const, before, after };
    });

    if (result.changed) {
      try { await invalidateTokensIssuedBefore(targetId); } catch (err) { logger.error({ err, targetId }, "Roles changed, but token invalidation failed"); }
    }
    return { changed: result.changed, ...(await this.get(targetId)) };
  },
};

import { ApiError } from "../../../common/ApiError";
import { auditService } from "../../admin/services/audit.service";
import { notificationsService } from "../../notifications/services/notifications.service";
import { supportRepository } from "../repositories/support.repository";
import { canTransition, MAX_ACTIVE_TICKETS_PER_USER, TicketStatus } from "./ticketStateMachine";

const pub = (t: any) => ({
  id: t.id, userId: t.user_id, userEmail: t.user_email, subject: t.subject, description: t.description, status: t.status as TicketStatus,
  priority: t.priority, assignedTo: t.assigned_to, resolvedAt: t.resolved_at, createdAt: t.created_at, updatedAt: t.updated_at,
});

/** The owner sees their ticket; staff see all. Everyone else gets 404 (no hint that it exists). */
async function loadVisible(id: string, userId: string, isStaff: boolean) {
  const t = await supportRepository.findById(id);
  if (!t || (t.user_id !== userId && !isStaff)) throw ApiError.notFound("Ticket not found");
  return t;
}

export const supportService = {
  async create(userId: string, input: { subject: string; description?: string; priority: string }) {
    const id = await supportRepository.createLimited(userId, input, MAX_ACTIVE_TICKETS_PER_USER);
    if (!id) throw ApiError.tooManyRequests(`You already have ${MAX_ACTIVE_TICKETS_PER_USER} open tickets; wait for some to be resolved`);
    return pub((await supportRepository.findById(id))!);
  },

  async listMine(userId: string, limit: number, cursor?: string) {
    const p = await supportRepository.listMine(userId, limit, cursor);
    return { tickets: p.items.map(pub), nextCursor: p.nextCursor };
  },

  async listAll(f: { status?: string; priority?: string }, limit: number, cursor?: string) {
    const p = await supportRepository.listAll(f, limit, cursor);
    return { tickets: p.items.map(pub), nextCursor: p.nextCursor };
  },

  async get(id: string, userId: string, isStaff: boolean) {
    const t = await loadVisible(id, userId, isStaff);
    return { ticket: pub(t), messages: (await supportRepository.messages(id)).map((m) => ({ id: m.id, authorId: m.author_id, isStaff: m.is_staff, body: m.body, createdAt: m.created_at })) };
  },

  async reply(id: string, userId: string, isStaff: boolean, body: string) {
    const t = await loadVisible(id, userId, isStaff);
    const text = body.trim();
    if (!text) throw ApiError.badRequest("Reply cannot be empty");
    const r = await supportRepository.addMessage(id, userId, isStaff, text, !isStaff);
    if (r.outcome === "closed") throw ApiError.conflict("This ticket is closed; open a new one");
    if (r.outcome === "missing") throw ApiError.notFound("Ticket not found");
    if (isStaff && t.user_id !== userId) void notificationsService.notify(t.user_id, "SUPPORT_REPLY", `${id}__${r.message.id}`, { subject: t.subject });
    return { id: r.message.id, authorId: r.message.author_id, isStaff: r.message.is_staff, body: r.message.body, createdAt: r.message.created_at };
  },

  /** Staff only. Status changes follow the state machine; every change is audited. */
  async update(actor: { id: string; ip?: string }, id: string, input: { status?: TicketStatus; priority?: string; assignToMe?: boolean }) {
    const t = await supportRepository.findById(id);
    if (!t) throw ApiError.notFound("Ticket not found");
    const from = t.status as TicketStatus;

    if (input.status && input.status !== from) {
      if (!canTransition(from, input.status)) throw ApiError.conflict(`A ${from} ticket cannot move to ${input.status}`);
      const moved = await supportRepository.transition(id, from, input.status, input.priority, input.assignToMe ? actor.id : undefined);
      if (!moved) throw ApiError.conflict("The ticket was changed by someone else; reload and retry");
    } else if (input.priority || input.assignToMe) {
      if (from === "CLOSED") throw ApiError.conflict("A closed ticket cannot be changed");
      if (input.priority) await supportRepository.setPriority(id, input.priority);
      if (input.assignToMe) await supportRepository.transition(id, from, from, undefined, actor.id);
    }
    await auditService.recordAfter({ actorId: actor.id, action: "support.ticket_updated", entityType: "support_ticket", entityId: id, metadata: { from, ...input }, ip: actor.ip });
    if (input.status === "RESOLVED") void notificationsService.notify(t.user_id, "SUPPORT_RESOLVED", id, { subject: t.subject });
    return pub((await supportRepository.findById(id))!);
  },
};

import { ApiError } from "../../../common/ApiError";
import { logger } from "../../../config/logger";
import { notificationsService } from "../../notifications/services/notifications.service";
import { NEXT_DUE_DAYS } from "../../repairs/services/repairCosts";
import { maintenanceRepository } from "../repositories/maintenance.repository";
import { DOCUMENT_GRACE_AFTER_EXPIRY_DAYS, DOCUMENT_HORIZON_DAYS, SERVICE_HORIZON_DAYS, documentStage, isoDay, serviceStage } from "./reminderRules";

const DAY = 86_400_000;

async function ownedVehicle(vehicleId: string, userId: string) {
  const owner = await maintenanceRepository.vehicleOwner(vehicleId);
  if (!owner || owner !== userId) throw ApiError.notFound("Vehicle not found"); // 404, never reveal another owner's vehicle
}

const rec = (r: any) => ({ id: r.id, vehicleId: r.vehicle_id, serviceType: r.service_type, cost: r.cost === null ? null : Number(r.cost), odometerKm: r.odometer_km, performedAt: r.performed_at, nextDueAt: r.next_due_at, notes: r.notes, source: r.source });
const doc = (d: any) => ({ id: d.id, vehicleId: d.vehicle_id, docType: d.doc_type, documentNumber: d.document_number, issuedAt: d.issued_at, expiresAt: d.expires_at, notes: d.notes });
const inc = (i: any) => ({ id: i.id, vehicleId: i.vehicle_id, occurredAt: i.occurred_at, severity: i.severity, description: i.description, repairCost: i.repair_cost === null ? null : Number(i.repair_cost) });

export const maintenanceService = {
  async addRecord(userId: string, vehicleId: string, input: { serviceType: string; cost?: number; odometerKm?: number; performedAt?: Date; notes?: string; nextDueAt?: Date | null }) {
    await ownedVehicle(vehicleId, userId);
    const performed = input.performedAt ?? new Date();
    if (performed.getTime() > Date.now() + DAY) throw ApiError.badRequest("A service cannot be recorded in the future");
    // Default schedule per service type, unless the owner set one (or explicitly null = no schedule).
    const days = NEXT_DUE_DAYS[input.serviceType];
    const nextDueAt = input.nextDueAt !== undefined ? input.nextDueAt : days ? new Date(performed.getTime() + days * DAY) : null;
    if (nextDueAt && nextDueAt <= performed) throw ApiError.badRequest("The next service must be after this one");
    return rec(await maintenanceRepository.addRecord(vehicleId, { ...input, performedAt: performed, nextDueAt }));
  },

  async addDocument(userId: string, vehicleId: string, input: { docType: string; documentNumber?: string; issuedAt?: string; expiresAt: string; notes?: string }) {
    await ownedVehicle(vehicleId, userId);
    try { return doc(await maintenanceRepository.addDocument(vehicleId, input)); }
    catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") throw ApiError.conflict("This document (same type and expiry) is already recorded");
      if (code === "23514") throw ApiError.badRequest("The issue date must not be after the expiry date");
      throw err;
    }
  },

  async deleteDocument(userId: string, vehicleId: string, documentId: string) {
    await ownedVehicle(vehicleId, userId);
    if (!(await maintenanceRepository.deleteDocument(vehicleId, documentId))) throw ApiError.notFound("Document not found");
  },

  async addIncident(userId: string, vehicleId: string, input: { occurredAt: string; severity: string; description: string; repairCost?: number }) {
    await ownedVehicle(vehicleId, userId);
    if (Date.parse(input.occurredAt) > Date.now() + DAY) throw ApiError.badRequest("An incident cannot be in the future");
    return inc(await maintenanceRepository.addIncident(vehicleId, input));
  },

  /** One call for the vehicle page: history, documents, accident history, total cost and what is coming up. */
  async overview(userId: string, vehicleId: string) {
    await ownedVehicle(vehicleId, userId);
    const [records, documents, incidents, totalCost] = await Promise.all([
      maintenanceRepository.records(vehicleId), maintenanceRepository.documents(vehicleId), maintenanceRepository.incidents(vehicleId), maintenanceRepository.costTotal(vehicleId),
    ]);
    return { records: records.map(rec), documents: documents.map(doc), incidents: incidents.map(inc), totalMaintenanceCost: totalCost };
  },

  /** Everything coming due across the owner's fleet (what the dashboard shows). Not a notification: just the live view. */
  async upcoming(userId: string, now = new Date()) {
    const [services, documents] = await Promise.all([
      maintenanceRepository.dueServices(new Date(now.getTime() + SERVICE_HORIZON_DAYS * DAY), userId),
      maintenanceRepository.expiringDocuments(isoDay(new Date(now.getTime() + DOCUMENT_HORIZON_DAYS * DAY)), isoDay(new Date(now.getTime() - DOCUMENT_GRACE_AFTER_EXPIRY_DAYS * DAY)), userId),
    ]);
    return {
      services: services.map((s) => ({ recordId: s.id, vehicleId: s.vehicle_id, vehicle: s.vehicle_title, serviceType: s.service_type, dueAt: s.next_due_at, stage: serviceStage(s.next_due_at, now) })),
      documents: documents.map((d) => ({ documentId: d.id, vehicleId: d.vehicle_id, vehicle: d.vehicle_title, docType: d.doc_type, expiresAt: d.expires_at, stage: documentStage(d.expires_at, now) })),
    };
  },

  /**
   * The daily sweep (BullMQ repeatable job; also callable by an admin). Finds due services and expiring documents and
   * enqueues notifications for the owner and the currently assigned driver. Safe to run any number of times: the stage is in
   * the notification's dedupe key, so each (item, stage, user) is delivered once. It never throws for one bad row.
   */
  async scan(now = new Date()) {
    const result = { services: 0, documents: 0, notificationsQueued: 0 };
    const [services, documents] = await Promise.all([
      maintenanceRepository.dueServices(new Date(now.getTime() + SERVICE_HORIZON_DAYS * DAY)),
      maintenanceRepository.expiringDocuments(isoDay(new Date(now.getTime() + DOCUMENT_HORIZON_DAYS * DAY)), isoDay(new Date(now.getTime() - DOCUMENT_GRACE_AFTER_EXPIRY_DAYS * DAY))),
    ]);

    const recipients = (r: { owner_id: string; current_driver_id: string | null }) => [...new Set([r.owner_id, r.current_driver_id].filter((x): x is string => !!x))];

    for (const s of services) {
      const stage = serviceStage(s.next_due_at, now);
      if (!stage) continue;
      result.services += 1;
      for (const userId of recipients(s)) {
        try {
          await notificationsService.notify(userId, "SERVICE_DUE", `${s.id}__${stage}`, { vehicle: s.vehicle_title, serviceType: s.service_type, stage, dueOn: isoDay(s.next_due_at) });
          result.notificationsQueued += 1;
        } catch (err) { logger.error({ err, recordId: s.id }, "Maintenance reminder failed"); }
      }
    }
    for (const d of documents) {
      const stage = documentStage(d.expires_at, now);
      if (!stage) continue;
      result.documents += 1;
      for (const userId of recipients(d)) {
        try {
          await notificationsService.notify(userId, "DOCUMENT_EXPIRING", `${d.id}__${stage}`, { vehicle: d.vehicle_title, docType: d.doc_type, stage: stage === "EXPIRED" ? "EXPIRED" : stage, expiresOn: isoDay(d.expires_at) });
          result.notificationsQueued += 1;
        } catch (err) { logger.error({ err, documentId: d.id }, "Document reminder failed"); }
      }
    }
    logger.info(result, "Maintenance scan complete");
    return result;
  },
};

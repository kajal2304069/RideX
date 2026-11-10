export type BookingStatus =
  | "REQUESTED" | "ACCEPTED" | "MECHANIC_ASSIGNED" | "VEHICLE_RECEIVED"
  | "REPAIR_IN_PROGRESS" | "READY" | "COMPLETED" | "CANCELLED";

export interface BookingRecord {
  id: string;
  garage_id: string;
  customer_id: string;
  vehicle_id: string | null;
  garage_service_id: string | null;
  mechanic_id: string | null;
  status: BookingStatus;
  is_emergency: boolean;
  scheduled_at: Date | null;
  idempotency_key: string | null;
  description: string | null;
  breakdown_lat: number | null;
  breakdown_lng: number | null;
  created_at: Date;
  updated_at: Date;
  garage_owner_id: string;
  garage_name: string;
}

export interface PartUsed {
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface RepairOrderRecord {
  id: string;
  service_booking_id: string;
  diagnosis: string | null;
  work_performed: string | null;
  parts_used: PartUsed[] | null;
  labor_cost: string;
  parts_cost: string;
  total_cost: string;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface MaintenanceRecordRow {
  id: string;
  vehicle_id: string;
  service_type: string | null;
  cost: string | null;
  odometer_km: number | null;
  performed_at: Date;
  next_due_at: Date | null;
  notes: string | null;
}

export function toPublicBooking(b: BookingRecord) {
  return {
    id: b.id,
    garage: { id: b.garage_id, name: b.garage_name },
    customerId: b.customer_id,
    vehicleId: b.vehicle_id,
    garageServiceId: b.garage_service_id,
    mechanicId: b.mechanic_id,
    status: b.status,
    isEmergency: b.is_emergency,
    scheduledAt: b.scheduled_at,
    description: b.description,
    breakdownLocation: b.breakdown_lat !== null && b.breakdown_lng !== null ? { lat: b.breakdown_lat, lng: b.breakdown_lng } : null,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

export function toPublicRepairOrder(r: RepairOrderRecord) {
  return {
    id: r.id,
    bookingId: r.service_booking_id,
    diagnosis: r.diagnosis,
    workPerformed: r.work_performed,
    partsUsed: r.parts_used ?? [],
    laborCost: Number(r.labor_cost),
    partsCost: Number(r.parts_cost),
    totalCost: Number(r.total_cost),
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

export function toPublicMaintenance(m: MaintenanceRecordRow) {
  return {
    id: m.id,
    vehicleId: m.vehicle_id,
    serviceType: m.service_type,
    cost: m.cost === null ? null : Number(m.cost),
    odometerKm: m.odometer_km,
    performedAt: m.performed_at,
    nextDueAt: m.next_due_at,
    notes: m.notes,
  };
}

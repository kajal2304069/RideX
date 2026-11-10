export interface Garage {
  id: string; ownerId: string; name: string; location: { lat: number; lng: number }; address: string | null; phone: string | null;
  openingHours: Record<string, string> | null; priceRange: string | null; ratingAvg: number | null; isActive: boolean;
  distanceMeters?: number; serviceTypes?: string[];
}
export interface GarageService { id: string; garageId: string; serviceType: string; priceFrom: number; priceTo: number; estimatedDurationMinutes: number }
export interface RepairOrder { id: string; diagnosis: string | null; workPerformed: string | null; partsUsed: Array<{ name: string; quantity: number; unitPrice: number }>; laborCost: number; partsCost: number; totalCost: number; startedAt: string | null; completedAt: string | null }
export interface RepairBooking {
  id: string; garage: { id: string; name: string }; customerId: string; vehicleId: string | null; garageServiceId: string | null; mechanicId: string | null;
  status: string; isEmergency: boolean; scheduledAt: string | null; description: string | null; breakdownLocation: { lat: number; lng: number } | null; createdAt: string;
}
export interface Mechanic { id: string; garageId: string; userId: string; name: string; specialization: string | null; isActive: boolean }

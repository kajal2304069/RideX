export interface RiderRecord {
  user_id: string;
  rating_avg: string; // numeric comes back as string from pg - see riders.repository.ts
  total_rides: number;
  created_at: Date;
  updated_at: Date;
}

export interface PublicRiderProfile {
  userId: string;
  ratingAvg: number;
  totalRides: number;
  createdAt: Date;
}

export function toPublicRiderProfile(rider: RiderRecord): PublicRiderProfile {
  return {
    userId: rider.user_id,
    ratingAvg: Number(rider.rating_avg),
    totalRides: rider.total_rides,
    createdAt: rider.created_at,
  };
}

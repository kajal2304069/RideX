export interface CandidateDriver {
  driverId: string;
  vehicleId: string;
  distanceMeters: number;
  etaSeconds: number;
  ratingAvg: number;
  score: number;
  scoreBreakdown: {
    distanceScore: number;
    etaScore: number;
    ratingScore: number;
  };
}

export interface MatchResult {
  rideId: string;
  searchRadiusMeters: number;
  candidatesFound: number;
  candidates: CandidateDriver[];
}

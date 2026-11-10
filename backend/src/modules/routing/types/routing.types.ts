export interface RoadNodeRecord {
  id: string;
  label: string | null;
  lat: number;
  lng: number;
}

export interface RoadEdgeRecord {
  from_node_id: string;
  to_node_id: string;
  distance_meters: string;
  is_bidirectional: boolean;
}

export interface RoutePoint {
  nodeId: string;
  label: string | null;
  lat: number;
  lng: number;
}

export interface RouteResult {
  path: RoutePoint[];
  distanceMeters: number;
  nodesExplored: number;
  totalGraphNodes: number;
  totalGraphEdges: number;
  algorithm: {
    name: "Dijkstra";
    timeComplexity: "O((V + E) log V)";
    spaceComplexity: "O(V + E)";
  };
}

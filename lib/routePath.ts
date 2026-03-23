export type RouteStatus = "loading" | "ready" | "failed";

export type RoutePathPoint = {
  lat: number;
  lng: number;
};

export type RoutePathStop = RoutePathPoint;

export type RoutePathEndpoints = {
  origin?: RoutePathPoint | null;
  destination?: RoutePathPoint | null;
} | null;

export type RouteTravelMode = "walk" | "drive";
export type GoogleRouteTravelMode = "WALKING" | "DRIVE";

export type RoutePathRequest = {
  origin: RoutePathPoint;
  destination: RoutePathPoint;
  intermediates?: Array<{
    location: RoutePathPoint;
  }>;
  travelMode: GoogleRouteTravelMode;
  fields: ["path"];
};

export type RouteLookupPlan =
  | { kind: "provided"; coords: [number, number][] }
  | { kind: "fetch"; request: RoutePathRequest }
  | { kind: "fallback" };

function samePoint(a: RoutePathPoint, b: RoutePathPoint) {
  return a.lat === b.lat && a.lng === b.lng;
}

export function resolveGoogleRouteTravelMode(
  mode?: RouteTravelMode | null
): GoogleRouteTravelMode | null {
  if (mode === "walk") return "WALKING";
  if (mode === "drive") return "DRIVE";
  return null;
}

function dedupeConsecutivePoints(points: RoutePathPoint[]) {
  const deduped: RoutePathPoint[] = [];

  for (const point of points) {
    const lastPoint = deduped[deduped.length - 1];
    if (lastPoint && samePoint(lastPoint, point)) {
      continue;
    }
    deduped.push(point);
  }

  return deduped;
}

function buildOrderedRoutePoints(params: {
  stops: RoutePathStop[];
  endpoints?: RoutePathEndpoints;
}) {
  const points: RoutePathPoint[] = [];

  if (params.endpoints?.origin) {
    points.push(params.endpoints.origin);
  }

  for (const stop of params.stops) {
    points.push({ lat: stop.lat, lng: stop.lng });
  }

  if (params.endpoints?.destination) {
    points.push(params.endpoints.destination);
  }

  return dedupeConsecutivePoints(points);
}

export function buildRoutePathRequest(params: {
  stops: RoutePathStop[];
  endpoints?: RoutePathEndpoints;
  routeTravelMode?: RouteTravelMode | null;
}): RoutePathRequest | null {
  const travelMode = resolveGoogleRouteTravelMode(params.routeTravelMode);
  if (!travelMode) return null;

  const orderedPoints = buildOrderedRoutePoints(params);
  if (orderedPoints.length < 2) return null;

  const request: RoutePathRequest = {
    origin: orderedPoints[0],
    destination: orderedPoints[orderedPoints.length - 1],
    travelMode,
    fields: ["path"],
  };

  const intermediates = orderedPoints.slice(1, -1);
  if (intermediates.length) {
    request.intermediates = intermediates.map((point) => ({
      location: point,
    }));
  }

  return request;
}

export function buildRouteLookupPlan(params: {
  providedRouteCoords?: [number, number][] | null;
  showRoutePath?: boolean;
  routeTravelMode?: RouteTravelMode | null;
  stops: RoutePathStop[];
  endpoints?: RoutePathEndpoints;
}): RouteLookupPlan {
  if (params.providedRouteCoords && params.providedRouteCoords.length > 1) {
    return {
      kind: "provided",
      coords: params.providedRouteCoords,
    };
  }

  if (!params.showRoutePath) {
    return { kind: "fallback" };
  }

  const request = buildRoutePathRequest({
    stops: params.stops,
    endpoints: params.endpoints,
    routeTravelMode: params.routeTravelMode,
  });

  if (!request) {
    return { kind: "fallback" };
  }

  return { kind: "fetch", request };
}

export function resolveVisibleRouteCoords(
  stops: RoutePathStop[],
  routedCoords?: [number, number][] | null,
  routeStatus: RouteStatus = "loading"
) {
  if (routedCoords?.length) return routedCoords;
  if (routeStatus !== "failed") return [];
  return stops.map((stop) => [stop.lng, stop.lat] as [number, number]);
}

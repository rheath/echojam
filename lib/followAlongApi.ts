import { decodeGooglePolyline, type FollowAlongLocation, type FollowAlongRoutePreview } from "@/lib/followAlong";

type GoogleDirectionsRoute = {
  overview_polyline?: { points?: string };
  legs?: Array<{
    distance?: { value?: number };
    duration?: { value?: number };
    start_address?: string;
    end_address?: string;
  }>;
};

type GoogleDirectionsResponse = {
  status?: string;
  routes?: GoogleDirectionsRoute[];
  error_message?: string;
};

type GooglePlaceSearchResponse = {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
    types?: string[];
  }>;
  error?: {
    message?: string;
  };
};

export type FollowAlongDestinationSearchResult = FollowAlongLocation & {
  title: string;
  types: string[];
};

function isFiniteCoord(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

export function normalizeDestinationQuery(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ");
}

export function isValidFollowAlongLocation(value: unknown): value is FollowAlongLocation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as FollowAlongLocation;
  return (
    typeof candidate.label === "string" &&
    candidate.label.trim().length > 0 &&
    isFiniteCoord(Number(candidate.lat), Number(candidate.lng))
  );
}

export async function searchFollowAlongDestinations(
  query: string
): Promise<FollowAlongDestinationSearchResult[]> {
  const normalizedQuery = normalizeDestinationQuery(query);
  if (normalizedQuery.length < 2) {
    throw new Error("Query must be at least 2 characters.");
  }

  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Google Places search is not configured.");
  }

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.types",
    },
    body: JSON.stringify({
      textQuery: normalizedQuery,
      maxResultCount: 6,
    }),
  });

  if (!res.ok) {
    throw new Error("Place search failed.");
  }

  const payload = (await res.json()) as GooglePlaceSearchResponse;
  if (payload.error?.message) {
    throw new Error("Place search failed.");
  }

  const results = (payload.places ?? []).reduce<FollowAlongDestinationSearchResult[]>(
    (acc, place) => {
      const title = (place.displayName?.text || "").trim();
      const subtitle = (place.formattedAddress || "").trim();
      const lat = Number(place.location?.latitude);
      const lng = Number(place.location?.longitude);
      if (!title || !isFiniteCoord(lat, lng)) return acc;
      acc.push({
        label: title,
        title,
        subtitle,
        lat,
        lng,
        placeId: (place.id || "").trim() || null,
        types: Array.isArray(place.types) ? place.types : [],
      });
      return acc;
    },
    []
  );
  return results;
}

function encodeLocation(value: FollowAlongLocation) {
  return `${value.lat},${value.lng}`;
}

export async function fetchDrivingRoutePreview(
  origin: FollowAlongLocation,
  destination: FollowAlongLocation
): Promise<FollowAlongRoutePreview> {
  if (!isValidFollowAlongLocation(origin) || !isValidFollowAlongLocation(destination)) {
    throw new Error("Valid origin and destination are required.");
  }

  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Google route preview is not configured.");
  }

  const params = new URLSearchParams({
    origin: encodeLocation(origin),
    destination: encodeLocation(destination),
    mode: "driving",
    key: apiKey,
  });
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`,
    { cache: "no-store" }
  );

  if (!res.ok) {
    throw new Error("Route preview failed.");
  }

  const payload = (await res.json()) as GoogleDirectionsResponse;
  if (payload.status !== "OK") {
    throw new Error(payload.error_message || "Route preview failed.");
  }

  const route = payload.routes?.[0];
  const leg = route?.legs?.[0];
  const polyline = (route?.overview_polyline?.points || "").trim();
  const routeCoords = polyline ? decodeGooglePolyline(polyline) : [];

  if (!route || !leg || routeCoords.length < 2) {
    throw new Error("Route preview failed.");
  }

  return {
    origin: {
      ...origin,
      subtitle: origin.subtitle || leg.start_address || null,
    },
    destination: {
      ...destination,
      subtitle: destination.subtitle || leg.end_address || null,
    },
    routeCoords,
    distanceMeters: Number(leg.distance?.value) || 0,
    durationSeconds: Number(leg.duration?.value) || 0,
  };
}

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

type GoogleGeocodeResponse = {
  status?: string;
  results?: Array<{
    formatted_address?: string;
  }>;
  error_message?: string;
};

type OsmReverseGeocodeResponse = {
  display_name?: string;
  error?: string;
  address?: {
    house_number?: string;
    road?: string;
    pedestrian?: string;
    footway?: string;
    path?: string;
    neighbourhood?: string;
    suburb?: string;
    city?: string;
    town?: string;
    village?: string;
    hamlet?: string;
    municipality?: string;
    county?: string;
    state?: string;
    postcode?: string;
  };
};

export type FollowAlongDestinationSearchResult = FollowAlongLocation & {
  title: string;
  types: string[];
};

const GOOGLE_GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
const OSM_REVERSE_GEOCODE_ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
const CURRENT_LOCATION_LABEL = "Current location";

function isFiniteCoord(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function normalizeOptionalText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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

export function buildFollowAlongOrigin(
  coords: { lat: number; lng: number },
  subtitle?: string | null
): FollowAlongLocation {
  return {
    label: CURRENT_LOCATION_LABEL,
    subtitle: normalizeOptionalText(subtitle),
    lat: coords.lat,
    lng: coords.lng,
  };
}

function withDetectedOriginAddress(
  coords: { lat: number; lng: number },
  address?: string | null
): FollowAlongLocation {
  const normalizedAddress = normalizeOptionalText(address);
  if (!normalizedAddress) {
    return buildFollowAlongOrigin(coords);
  }
  return {
    label: normalizedAddress,
    subtitle: CURRENT_LOCATION_LABEL,
    lat: coords.lat,
    lng: coords.lng,
  };
}

async function reverseGeocodeWithGoogle(
  coords: { lat: number; lng: number }
): Promise<string | null> {
  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || "").trim();
  if (!apiKey) return null;

  try {
    const params = new URLSearchParams({
      latlng: `${coords.lat},${coords.lng}`,
      key: apiKey,
    });
    const res = await fetch(`${GOOGLE_GEOCODE_ENDPOINT}?${params.toString()}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;

    const payload = (await res.json()) as GoogleGeocodeResponse;
    if (payload.status && payload.status !== "OK" && payload.status !== "ZERO_RESULTS") {
      return null;
    }

    return normalizeOptionalText(payload.results?.[0]?.formatted_address);
  } catch {
    return null;
  }
}

function formatOsmAddress(payload: OsmReverseGeocodeResponse): string | null {
  const streetName = normalizeOptionalText(
    payload.address?.road ||
      payload.address?.pedestrian ||
      payload.address?.footway ||
      payload.address?.path
  );
  const houseNumber = normalizeOptionalText(payload.address?.house_number);
  const street = [houseNumber, streetName].filter(Boolean).join(" ").trim();
  const locality = normalizeOptionalText(
    payload.address?.city ||
      payload.address?.town ||
      payload.address?.village ||
      payload.address?.hamlet ||
      payload.address?.municipality ||
      payload.address?.suburb ||
      payload.address?.neighbourhood ||
      payload.address?.county
  );
  const region = [normalizeOptionalText(payload.address?.state), normalizeOptionalText(payload.address?.postcode)]
    .filter(Boolean)
    .join(" ")
    .trim();
  const compact = [street, locality, region].filter(Boolean).join(", ").trim();
  return normalizeOptionalText(compact) || normalizeOptionalText(payload.display_name);
}

async function reverseGeocodeWithOsm(
  coords: { lat: number; lng: number }
): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      format: "jsonv2",
      lat: String(coords.lat),
      lon: String(coords.lng),
      zoom: "18",
      addressdetails: "1",
    });
    const res = await fetch(`${OSM_REVERSE_GEOCODE_ENDPOINT}?${params.toString()}`, {
      cache: "no-store",
      headers: {
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "EchoJam/1.0 (follow-along origin lookup)",
      },
    });
    if (!res.ok) return null;

    const payload = (await res.json()) as OsmReverseGeocodeResponse;
    if (normalizeOptionalText(payload.error)) return null;
    return formatOsmAddress(payload);
  } catch {
    return null;
  }
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

export async function reverseGeocodeFollowAlongOrigin(
  coords: { lat: number; lng: number }
): Promise<FollowAlongLocation> {
  if (!isFiniteCoord(coords.lat, coords.lng)) {
    throw new Error("Valid origin coordinates are required.");
  }

  const googleAddress = await reverseGeocodeWithGoogle(coords);
  if (googleAddress) {
    return withDetectedOriginAddress(coords, googleAddress);
  }

  const osmAddress = await reverseGeocodeWithOsm(coords);
  if (osmAddress) {
    return withDetectedOriginAddress(coords, osmAddress);
  }

  return buildFollowAlongOrigin(coords);
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
    origin:
      normalizeOptionalText(origin.label) === CURRENT_LOCATION_LABEL
        ? withDetectedOriginAddress(
            { lat: origin.lat, lng: origin.lng },
            normalizeOptionalText(origin.subtitle) || normalizeOptionalText(leg.start_address)
          )
        : {
            ...origin,
            subtitle: normalizeOptionalText(origin.subtitle) || normalizeOptionalText(leg.start_address),
          },
    destination: {
      ...destination,
      subtitle: normalizeOptionalText(destination.subtitle) || normalizeOptionalText(leg.end_address),
    },
    routeCoords,
    distanceMeters: Number(leg.distance?.value) || 0,
    durationSeconds: Number(leg.duration?.value) || 0,
  };
}

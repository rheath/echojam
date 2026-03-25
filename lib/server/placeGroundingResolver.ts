import "server-only";

import {
  buildPlaceGroundingSignature,
  type PlaceGrounding,
  type PlaceGroundingSource,
} from "@/lib/placeGrounding";

type PlaceGroundingInput = {
  title: string;
  googlePlaceId?: string | null;
  lat?: number | null;
  lng?: number | null;
  formattedAddress?: string | null;
};

type GooglePlaceDetailsResponse = {
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
};

type GeocodeComponent = {
  long_name?: string;
  short_name?: string;
  types?: string[];
};

type GoogleGeocodeResponse = {
  status?: string;
  results?: Array<{
    address_components?: GeocodeComponent[];
  }>;
};

const GOOGLE_PLACE_DETAILS_ENDPOINT = "https://places.googleapis.com/v1/places";
const GOOGLE_GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
const GENERIC_PLACE_TYPES = new Set([
  "establishment",
  "point_of_interest",
  "premise",
  "food",
  "store",
]);

function normalizeOptionalText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isFiniteCoord(lat: number | null | undefined, lng: number | null | undefined) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180;
}

function toDisplayType(value: string | null | undefined) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;
  return normalized
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function pickVenueCategory(types: string[] | null | undefined) {
  for (const rawType of types ?? []) {
    const normalized = normalizeOptionalText(rawType)?.toLowerCase() || null;
    if (!normalized || GENERIC_PLACE_TYPES.has(normalized)) continue;
    return toDisplayType(normalized);
  }
  return null;
}

function findAddressComponent(
  components: GeocodeComponent[],
  types: string[]
) {
  return (
    components.find((component) =>
      (component.types ?? []).some((type) => types.includes(type))
    ) ?? null
  );
}

function buildLocalContext(value: {
  venueCategory?: string | null;
  neighborhood?: string | null;
  city?: string | null;
}) {
  const venueCategory = normalizeOptionalText(value.venueCategory);
  const neighborhood = normalizeOptionalText(value.neighborhood);
  const city = normalizeOptionalText(value.city);

  if (venueCategory && neighborhood && city) {
    return `${venueCategory} in ${neighborhood}, ${city}`;
  }
  if (venueCategory && city) {
    return `${venueCategory} in ${city}`;
  }
  if (neighborhood && city) {
    return `${neighborhood}, ${city}`;
  }
  return venueCategory || neighborhood || city || null;
}

async function fetchPlaceDetails(
  googlePlaceId: string
) {
  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || "").trim();
  if (!apiKey) return null;

  try {
    const res = await fetch(`${GOOGLE_PLACE_DETAILS_ENDPOINT}/${encodeURIComponent(googlePlaceId)}`, {
      cache: "no-store",
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "displayName,formattedAddress,location,types",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as GooglePlaceDetailsResponse;
  } catch {
    return null;
  }
}

async function reverseGeocode(
  lat: number,
  lng: number
) {
  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || "").trim();
  if (!apiKey) return [] as GeocodeComponent[];

  try {
    const params = new URLSearchParams({
      latlng: `${lat},${lng}`,
      key: apiKey,
    });
    const res = await fetch(`${GOOGLE_GEOCODE_ENDPOINT}?${params.toString()}`, {
      cache: "no-store",
    });
    if (!res.ok) return [] as GeocodeComponent[];

    const payload = (await res.json()) as GoogleGeocodeResponse;
    if (!Array.isArray(payload.results) || payload.results.length === 0) return [] as GeocodeComponent[];
    return payload.results[0]?.address_components ?? [];
  } catch {
    return [] as GeocodeComponent[];
  }
}

export async function resolvePlaceGrounding(
  input: PlaceGroundingInput
): Promise<PlaceGrounding | null> {
  const title = normalizeOptionalText(input.title);
  if (!title) return null;

  const googlePlaceId = normalizeOptionalText(input.googlePlaceId);
  const details = googlePlaceId ? await fetchPlaceDetails(googlePlaceId) : null;
  const detailLat = Number(details?.location?.latitude);
  const detailLng = Number(details?.location?.longitude);
  const lat = isFiniteCoord(detailLat, detailLng) ? detailLat : Number(input.lat);
  const lng = isFiniteCoord(detailLat, detailLng) ? detailLng : Number(input.lng);
  const components = isFiniteCoord(lat, lng) ? await reverseGeocode(lat, lng) : [];

  const neighborhood =
    normalizeOptionalText(
      findAddressComponent(components, [
        "neighborhood",
        "sublocality_level_1",
        "sublocality",
        "sublocality_level_2",
      ])?.long_name
    ) || null;
  const city =
    normalizeOptionalText(
      findAddressComponent(components, ["locality", "postal_town"])?.long_name
    ) || null;
  const region =
    normalizeOptionalText(
      findAddressComponent(components, ["administrative_area_level_1"])?.long_name
    ) || null;
  const country =
    normalizeOptionalText(findAddressComponent(components, ["country"])?.long_name) || null;
  const venueCategory = pickVenueCategory(details?.types);
  const formattedAddress =
    normalizeOptionalText(input.formattedAddress) ||
    normalizeOptionalText(details?.formattedAddress);
  const resolvedName =
    normalizeOptionalText(details?.displayName?.text) ||
    title;
  const source: PlaceGroundingSource = details
    ? "google_place_details"
    : components.length > 0
      ? "reverse_geocode"
      : "provided_place";
  const localContext = buildLocalContext({
    venueCategory,
    neighborhood,
    city,
  });

  const signature = buildPlaceGroundingSignature({
    placeId: googlePlaceId,
    resolvedName,
    formattedAddress,
    venueCategory,
    neighborhood,
    city,
    region,
    country,
  });

  return {
    placeId: googlePlaceId,
    resolvedName,
    formattedAddress,
    venueCategory,
    neighborhood,
    city,
    region,
    country,
    localContext,
    source,
    signature,
  };
}

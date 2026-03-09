import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildGooglePlacePhotoUrl,
  buildGoogleStreetViewUrl,
  cityPlaceholderImage,
  isValidGooglePlaceId,
  proxyGoogleImageUrl,
} from "@/lib/placesImages";

export type NearbyStorySource = "canonical" | "google_places" | "locality_fallback";

export type NearbyPlaceCandidate = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  image: string;
  source: NearbyStorySource;
  distanceMeters: number | null;
  googlePlaceId: string | null;
};

export type ResolveNearbyPlaceInput = {
  admin: SupabaseClient;
  city: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  maxCandidates?: number;
  googleOnly?: boolean;
  includedPrimaryTypes?: string[] | null;
  allowBroadGoogleFallback?: boolean;
};

export type ResolveNearbyPlaceResult = {
  candidate: NearbyPlaceCandidate | null;
  missingGooglePlacesKey: boolean;
};

export type ResolveNearbyPlacesResult = {
  candidates: NearbyPlaceCandidate[];
  missingGooglePlacesKey: boolean;
  googleNearbyStatus: string | null;
  googleNearbyHttpStatus: number | null;
};

type GoogleNearbyPlace = {
  id?: string;
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  photos?: Array<{ name?: string }>;
  primaryType?: string;
  types?: string[];
};

type GoogleNearbyResponse = {
  places?: GoogleNearbyPlace[];
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

type GoogleNearbyQueryOptions = {
  includedPrimaryTypes?: string[] | null;
};

type GoogleGeocodeResult = {
  place_id?: string;
  formatted_address?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
};

type GoogleGeocodeResponse = {
  status?: string;
  results?: GoogleGeocodeResult[];
};

const GOOGLE_NEARBY_ENDPOINT = "https://places.googleapis.com/v1/places:searchNearby";
const GOOGLE_GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";
const GOOGLE_NEARBY_INCLUDED_PRIMARY_TYPES = [
  "tourist_attraction",
  "museum",
  "art_gallery",
  "church",
  "library",
  "park",
];
const POI_TYPE_ALLOWLIST = new Set([
  "tourist_attraction",
  "museum",
  "art_gallery",
  "historical_landmark",
  "monument",
  "church",
  "library",
  "visitor_center",
  "park",
]);
const BUSINESS_TYPE_BLOCKLIST = new Set([
  "doctor",
  "dentist",
  "physiotherapist",
  "hospital",
  "medical_lab",
  "corporate_office",
  "insurance_agency",
  "accounting",
  "real_estate_agency",
  "restaurant",
  "cafe",
  "bar",
  "bakery",
  "meal_takeaway",
  "meal_delivery",
  "store",
  "shopping_mall",
  "supermarket",
  "lodging",
  "hotel",
  "gym",
  "beauty_salon",
  "car_dealer",
  "car_repair",
  "gas_station",
  "bank",
  "atm",
  "pharmacy",
]);

const MAX_NEARBY_CANDIDATES = 9;
function isFiniteCoord(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function normalizeType(value: string | null | undefined) {
  return (value || "").trim().toLowerCase();
}

function isLowQualityTitle(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.length < 4) return true;
  if (normalized === "alt" || normalized === "untitled") return true;
  return false;
}

function isPoiLike(primaryType: string | null | undefined, types: string[] | undefined) {
  const normalizedPrimary = normalizeType(primaryType);
  if (normalizedPrimary && POI_TYPE_ALLOWLIST.has(normalizedPrimary)) return true;
  for (const type of types ?? []) {
    if (POI_TYPE_ALLOWLIST.has(normalizeType(type))) return true;
  }
  return false;
}

function isBusinessLike(primaryType: string | null | undefined, types: string[] | undefined) {
  const normalizedPrimary = normalizeType(primaryType);
  if (normalizedPrimary && BUSINESS_TYPE_BLOCKLIST.has(normalizedPrimary)) return true;
  for (const type of types ?? []) {
    if (BUSINESS_TYPE_BLOCKLIST.has(normalizeType(type))) return true;
  }
  return false;
}

function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number) {
  const avgLatRad = ((aLat + bLat) / 2) * (Math.PI / 180);
  const metersPerLat = 111_320;
  const metersPerLng = 111_320 * Math.cos(avgLatRad);
  const dLat = (aLat - bLat) * metersPerLat;
  const dLng = (aLng - bLng) * metersPerLng;
  return Math.hypot(dLat, dLng);
}

async function resolveGoogleNearby(
  apiKey: string,
  city: string,
  lat: number,
  lng: number,
  radiusMeters: number,
  options?: GoogleNearbyQueryOptions
): Promise<{ candidates: NearbyPlaceCandidate[]; status: string | null; httpStatus: number | null }> {
  const includedPrimaryTypes =
    options?.includedPrimaryTypes === undefined
      ? GOOGLE_NEARBY_INCLUDED_PRIMARY_TYPES
      : options.includedPrimaryTypes;
  const res = await fetch(GOOGLE_NEARBY_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.photos,places.primaryType,places.types",
    },
    body: JSON.stringify({
      maxResultCount: 20,
      rankPreference: "DISTANCE",
      ...(includedPrimaryTypes && includedPrimaryTypes.length > 0 ? { includedPrimaryTypes } : {}),
      locationRestriction: {
        circle: {
          center: {
            latitude: lat,
            longitude: lng,
          },
          radius: Math.max(1, Math.round(radiusMeters)),
        },
      },
    }),
  });

  const payload = (await res.json()) as GoogleNearbyResponse;
  const rawStatus = payload.error?.status || (Array.isArray(payload.places) && payload.places.length > 0 ? "OK" : "ZERO_RESULTS");
  if (!res.ok) return { candidates: [], status: rawStatus, httpStatus: res.status };
  if (!Array.isArray(payload.places) || payload.places.length === 0) {
    return { candidates: [], status: rawStatus, httpStatus: res.status };
  }

  const candidates: NearbyPlaceCandidate[] = [];
  const poiCandidates: NearbyPlaceCandidate[] = [];
  const businessCandidates: NearbyPlaceCandidate[] = [];
  const placeholder = cityPlaceholderImage(city);

  for (const place of payload.places) {
    const pLat = Number(place.location?.latitude);
    const pLng = Number(place.location?.longitude);
    if (!isFiniteCoord(pLat, pLng)) continue;

    const dist = distanceMeters(lat, lng, pLat, pLng);
    if (dist > radiusMeters) continue;

    const placeName = (place.displayName?.text || "").trim();
    const placeId = (place.id || "").trim();
    if (!placeName || isLowQualityTitle(placeName) || !isValidGooglePlaceId(placeId)) continue;

    const photoRef = place.photos?.[0]?.name;
    const image = photoRef ? buildGooglePlacePhotoUrl(photoRef) : buildGoogleStreetViewUrl(pLat, pLng) || placeholder;
    candidates.push({
      id: `nearby-gplace-${placeId || `${pLat.toFixed(6)}-${pLng.toFixed(6)}`}`,
      title: placeName,
      lat: pLat,
      lng: pLng,
      image,
      source: "google_places",
      distanceMeters: dist,
      googlePlaceId: placeId || null,
    });
    const latest = candidates[candidates.length - 1];
    if (isPoiLike(place.primaryType, place.types)) {
      poiCandidates.push(latest);
      continue;
    }
    if (isBusinessLike(place.primaryType, place.types)) {
      businessCandidates.push(latest);
    }
  }

  const selectedCandidates =
    poiCandidates.length > 0
      ? poiCandidates
      : candidates.filter((candidate) => !businessCandidates.some((business) => business.id === candidate.id));
  const fallbackCandidates = selectedCandidates.length > 0 ? selectedCandidates : candidates;

  return { candidates: fallbackCandidates, status: rawStatus, httpStatus: res.status };
}

async function resolveLocalityFallback(
  apiKey: string,
  city: string,
  lat: number,
  lng: number
): Promise<NearbyPlaceCandidate | null> {
  const params = new URLSearchParams({
    latlng: `${lat},${lng}`,
    result_type: "locality|sublocality|administrative_area_level_3|neighborhood",
    key: apiKey,
  });
  const res = await fetch(`${GOOGLE_GEOCODE_ENDPOINT}?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) return null;

  const payload = (await res.json()) as GoogleGeocodeResponse;
  if (!Array.isArray(payload.results) || payload.results.length === 0) return null;
  if (payload.status && payload.status !== "OK" && payload.status !== "ZERO_RESULTS") return null;

  const first = payload.results[0];
  const title = (first.formatted_address || "").trim();
  if (!title) return null;

  const localityGooglePlaceId = (first.place_id || "").trim();

  return {
    id: `nearby-locality-${lat.toFixed(5)}-${lng.toFixed(5)}`,
    title,
    lat,
    lng,
    image: cityPlaceholderImage(city),
    source: "locality_fallback",
    distanceMeters: null,
    googlePlaceId: isValidGooglePlaceId(localityGooglePlaceId) ? localityGooglePlaceId : null,
  };
}

function candidateKey(candidate: NearbyPlaceCandidate) {
  const placeId = (candidate.googlePlaceId || "").trim().toLowerCase();
  if (placeId) return `place:${placeId}`;
  return `coord:${candidate.lat.toFixed(5)}:${candidate.lng.toFixed(5)}:${candidate.title.trim().toLowerCase()}`;
}

function sourceRank(source: NearbyStorySource) {
  if (source === "canonical") return 0;
  if (source === "google_places") return 1;
  return 2;
}

function withBestCandidate(existing: NearbyPlaceCandidate, incoming: NearbyPlaceCandidate) {
  const existingRank = sourceRank(existing.source);
  const incomingRank = sourceRank(incoming.source);
  if (incomingRank < existingRank) return incoming;
  if (incomingRank > existingRank) return existing;
  const existingDistance = Number.isFinite(existing.distanceMeters) ? Number(existing.distanceMeters) : Number.POSITIVE_INFINITY;
  const incomingDistance = Number.isFinite(incoming.distanceMeters) ? Number(incoming.distanceMeters) : Number.POSITIVE_INFINITY;
  if (incomingDistance < existingDistance) return incoming;
  if (incomingDistance > existingDistance) return existing;
  return incoming.title.localeCompare(existing.title, undefined, { sensitivity: "base" }) < 0 ? incoming : existing;
}

function clampMaxCandidates(maxCandidates: number | null | undefined) {
  const parsed = Math.trunc(Number(maxCandidates));
  if (!Number.isFinite(parsed) || parsed <= 0) return MAX_NEARBY_CANDIDATES;
  return Math.min(MAX_NEARBY_CANDIDATES, parsed);
}

function isSyntheticOverviewTitle(title: string) {
  return title.trim().toLowerCase().startsWith("overview of ");
}

async function resolveCanonicalNearby(input: ResolveNearbyPlaceInput): Promise<NearbyPlaceCandidate[]> {
  const { data, error } = await input.admin
    .from("canonical_stops")
    .select("id,title,lat,lng,image_url,google_place_id")
    .eq("city", input.city);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<{
    id: string;
    title: string;
    lat: number;
    lng: number;
    image_url: string | null;
    google_place_id: string | null;
  }>;

  const candidates = rows
    .filter((row) => !isSyntheticOverviewTitle(row.title))
    .map((row) => {
      const dist = distanceMeters(input.lat, input.lng, row.lat, row.lng);
      return {
        id: row.id,
        title: row.title,
        lat: row.lat,
        lng: row.lng,
        image: proxyGoogleImageUrl(row.image_url) || cityPlaceholderImage(input.city),
        source: "canonical" as const,
        distanceMeters: dist,
        googlePlaceId: isValidGooglePlaceId(row.google_place_id) ? (row.google_place_id || "").trim() : null,
      };
    })
    .filter((candidate) => Number(candidate.distanceMeters) <= input.radiusMeters)
    .sort((a, b) => Number(a.distanceMeters) - Number(b.distanceMeters));

  return candidates;
}

export async function resolveNearbyPlaces(input: ResolveNearbyPlaceInput): Promise<ResolveNearbyPlacesResult> {
  const maxCandidates = clampMaxCandidates(input.maxCandidates);
  const googleOnly = Boolean(input.googleOnly);
  const includedPrimaryTypes = input.includedPrimaryTypes ?? GOOGLE_NEARBY_INCLUDED_PRIMARY_TYPES;
  const allowBroadGoogleFallback = input.allowBroadGoogleFallback ?? true;
  const canonicalCandidates = googleOnly ? [] : await resolveCanonicalNearby(input);
  const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) {
    return {
      candidates: canonicalCandidates.slice(0, maxCandidates),
      missingGooglePlacesKey: canonicalCandidates.length === 0,
      googleNearbyStatus: null,
      googleNearbyHttpStatus: null,
    };
  }

  const strictNearby = await resolveGoogleNearby(apiKey, input.city, input.lat, input.lng, input.radiusMeters, {
    includedPrimaryTypes,
  });
  const broadNearby =
    allowBroadGoogleFallback && strictNearby.candidates.length < 3
      ? await resolveGoogleNearby(apiKey, input.city, input.lat, input.lng, input.radiusMeters, {
          includedPrimaryTypes: null,
        })
      : null;
  const googleNearby = broadNearby ?? strictNearby;
  const googleCandidates = [...strictNearby.candidates, ...(broadNearby?.candidates ?? [])];
  const byKey = new Map<string, NearbyPlaceCandidate>();
  for (const candidate of [...canonicalCandidates, ...googleCandidates]) {
    const key = candidateKey(candidate);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }
    byKey.set(key, withBestCandidate(existing, candidate));
  }

  if (!googleOnly && byKey.size === 0) {
    const locality = await resolveLocalityFallback(apiKey, input.city, input.lat, input.lng);
    if (locality) {
      byKey.set(candidateKey(locality), locality);
    }
  }

  const candidates = Array.from(byKey.values())
    .sort((a, b) => {
      const aDistance = Number.isFinite(a.distanceMeters) ? Number(a.distanceMeters) : Number.POSITIVE_INFINITY;
      const bDistance = Number.isFinite(b.distanceMeters) ? Number(b.distanceMeters) : Number.POSITIVE_INFINITY;
      if (aDistance !== bDistance) return aDistance - bDistance;
      return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    })
    .slice(0, maxCandidates);

  return {
    candidates,
    missingGooglePlacesKey: false,
    googleNearbyStatus: googleNearby.status,
    googleNearbyHttpStatus: googleNearby.httpStatus,
  };
}

export async function resolveNearbyPlace(input: ResolveNearbyPlaceInput): Promise<ResolveNearbyPlaceResult> {
  const resolved = await resolveNearbyPlaces({ ...input, maxCandidates: 1 });
  return {
    candidate: resolved.candidates[0] ?? null,
    missingGooglePlacesKey: resolved.missingGooglePlacesKey,
  };
}

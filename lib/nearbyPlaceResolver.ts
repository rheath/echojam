import type { SupabaseClient } from "@supabase/supabase-js";
import { findNearestCanonicalStopWithinRadius } from "@/lib/canonicalStops";
import { cityPlaceholderImage } from "@/lib/placesImages";

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
};

export type ResolveNearbyPlaceResult = {
  candidate: NearbyPlaceCandidate | null;
  missingGooglePlacesKey: boolean;
};

type GoogleNearbyPlace = {
  place_id?: string;
  name?: string;
  types?: string[];
  geometry?: { location?: { lat?: number; lng?: number } };
  photos?: Array<{ photo_reference?: string }>;
};

type GoogleNearbyResponse = {
  status?: string;
  results?: GoogleNearbyPlace[];
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

const GOOGLE_NEARBY_ENDPOINT = "https://maps.googleapis.com/maps/api/place/nearbysearch/json";
const GOOGLE_GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";

const TYPE_PRIORITY: Record<string, number> = {
  museum: 20,
  tourist_attraction: 20,
  art_gallery: 18,
  historical_landmark: 18,
  church: 16,
  monument: 16,
  point_of_interest: 12,
  establishment: 6,
};

function isFiniteCoord(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number) {
  const avgLatRad = ((aLat + bLat) / 2) * (Math.PI / 180);
  const metersPerLat = 111_320;
  const metersPerLng = 111_320 * Math.cos(avgLatRad);
  const dLat = (aLat - bLat) * metersPerLat;
  const dLng = (aLng - bLng) * metersPerLng;
  return Math.hypot(dLat, dLng);
}

function scorePlace(types: string[] | undefined, distMeters: number) {
  let score = 0;
  for (const type of types ?? []) {
    score += TYPE_PRIORITY[type] ?? 0;
  }
  // Slightly prefer closer results among similarly notable places.
  score -= distMeters / 40;
  return score;
}

function buildGooglePhotoUrl(reference: string, apiKey: string) {
  const params = new URLSearchParams({
    maxwidth: "1400",
    photo_reference: reference,
    key: apiKey,
  });
  return `https://maps.googleapis.com/maps/api/place/photo?${params.toString()}`;
}

async function resolveGoogleNearby(
  apiKey: string,
  city: string,
  lat: number,
  lng: number,
  radiusMeters: number
): Promise<NearbyPlaceCandidate | null> {
  const params = new URLSearchParams({
    location: `${lat},${lng}`,
    radius: String(Math.max(1, Math.round(radiusMeters))),
    key: apiKey,
  });

  const res = await fetch(`${GOOGLE_NEARBY_ENDPOINT}?${params.toString()}`, { cache: "no-store" });
  if (!res.ok) return null;

  const payload = (await res.json()) as GoogleNearbyResponse;
  if (!Array.isArray(payload.results) || payload.results.length === 0) return null;
  if (payload.status && payload.status !== "OK" && payload.status !== "ZERO_RESULTS") return null;

  let best: NearbyPlaceCandidate | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  const placeholder = cityPlaceholderImage(city);

  for (const place of payload.results) {
    const pLat = Number(place.geometry?.location?.lat);
    const pLng = Number(place.geometry?.location?.lng);
    if (!isFiniteCoord(pLat, pLng)) continue;

    const dist = distanceMeters(lat, lng, pLat, pLng);
    if (dist > radiusMeters) continue;

    const placeName = (place.name || "").trim();
    if (!placeName) continue;

    const score = scorePlace(place.types, dist);
    const photoRef = place.photos?.[0]?.photo_reference;
    const image = photoRef ? buildGooglePhotoUrl(photoRef, apiKey) : placeholder;
    if (score > bestScore) {
      bestScore = score;
      best = {
        id: `nearby-gplace-${(place.place_id || "").trim() || `${pLat.toFixed(6)}-${pLng.toFixed(6)}`}`,
        title: placeName,
        lat: pLat,
        lng: pLng,
        image,
        source: "google_places",
        distanceMeters: dist,
        googlePlaceId: (place.place_id || "").trim() || null,
      };
    }
  }

  return best;
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

  return {
    id: `nearby-locality-${lat.toFixed(5)}-${lng.toFixed(5)}`,
    title,
    lat,
    lng,
    image: cityPlaceholderImage(city),
    source: "locality_fallback",
    distanceMeters: null,
    googlePlaceId: (first.place_id || "").trim() || null,
  };
}

export async function resolveNearbyPlace(input: ResolveNearbyPlaceInput): Promise<ResolveNearbyPlaceResult> {
  const canonical = await findNearestCanonicalStopWithinRadius(
    input.admin,
    input.city,
    input.lat,
    input.lng,
    input.radiusMeters
  );
  if (canonical) {
    return {
      candidate: {
        id: canonical.id,
        title: canonical.title,
        lat: canonical.lat,
        lng: canonical.lng,
        image: canonical.image_url || cityPlaceholderImage(input.city),
        source: "canonical",
        distanceMeters: distanceMeters(input.lat, input.lng, canonical.lat, canonical.lng),
        googlePlaceId: (canonical.google_place_id || "").trim() || null,
      },
      missingGooglePlacesKey: false,
    };
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!apiKey) {
    return { candidate: null, missingGooglePlacesKey: true };
  }

  const googlePlace = await resolveGoogleNearby(apiKey, input.city, input.lat, input.lng, input.radiusMeters);
  if (googlePlace) {
    return { candidate: googlePlace, missingGooglePlacesKey: false };
  }

  const locality = await resolveLocalityFallback(apiKey, input.city, input.lat, input.lng);
  if (locality) {
    return { candidate: locality, missingGooglePlacesKey: false };
  }

  return { candidate: null, missingGooglePlacesKey: false };
}

import { NextResponse } from "next/server";
import { cityPlaceholderImage, isValidGooglePlaceId } from "@/lib/placesImages";

type Body = {
  city?: string;
  query?: string;
  limit?: number;
};

type GooglePlace = {
  id?: string;
  name?: string;
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  types?: string[];
  rating?: number;
  userRatingCount?: number;
};

type GooglePlacesSearchResponse = {
  places?: GooglePlace[];
  error?: {
    message?: string;
  };
};

type CandidateStop = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  image: string;
  googlePlaceId?: string;
};

const GOOGLE_PLACES_NEW_SEARCH_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const DEFAULT_LIMIT = 5;
const DEFAULT_CITY_QUERY_LIMIT = 5;
const MAX_LIMIT = 10;
const SEARCH_TIMEOUT_MS = 5000;
const MIN_QUERY_LENGTH = 2;
const VALID_CITIES = new Set(["salem", "boston", "concord", "nyc"]);
const POI_TYPE_WEIGHTS: Record<string, number> = {
  tourist_attraction: 26,
  museum: 24,
  historical_landmark: 22,
  art_gallery: 18,
  monument: 18,
  church: 16,
  point_of_interest: 10,
};
const NON_CITY_HINTS = [
  "street",
  "st",
  "avenue",
  "ave",
  "road",
  "rd",
  "boulevard",
  "blvd",
  "drive",
  "dr",
  "lane",
  "ln",
  "square",
  "sq",
  "bridge",
  "museum",
  "park",
  "station",
  "airport",
  "hotel",
  "restaurant",
  "cafe",
  "bar",
];

function toNormalizedCity(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!VALID_CITIES.has(normalized)) return null;
  return normalized;
}

function toSafeLimit(raw: unknown, cityLikeQuery: boolean) {
  const defaultLimit = cityLikeQuery ? DEFAULT_CITY_QUERY_LIMIT : DEFAULT_LIMIT;
  if (typeof raw === "undefined" || raw === null) return defaultLimit;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultLimit;
  return Math.min(MAX_LIMIT, parsed);
}

function isFiniteCoord(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function toStopId(placeId: string, lat: number, lng: number) {
  if (isValidGooglePlaceId(placeId)) return `ext-gplace-${placeId}`;
  return `ext-search-${lat.toFixed(6)},${lng.toFixed(6)}`;
}

function isCityLikeQuery(query: string) {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < MIN_QUERY_LENGTH) return false;
  if (/[0-9]/.test(normalized)) return false;
  if (/[#@/]/.test(normalized)) return false;
  const tokens = normalized
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return false;
  if (tokens.some((token) => NON_CITY_HINTS.includes(token))) return false;
  return true;
}

function poiScore(place: GooglePlace) {
  let score = 0;
  for (const type of place.types ?? []) {
    score += POI_TYPE_WEIGHTS[type] ?? 0;
  }
  const rating = Number(place.rating);
  const ratingCount = Number(place.userRatingCount);
  if (Number.isFinite(rating)) score += rating * 2;
  if (Number.isFinite(ratingCount) && ratingCount > 0) {
    score += Math.min(8, Math.log10(ratingCount + 1) * 2);
  }
  return score;
}

async function runTextSearch(query: string, limit: number, apiKey: string, signal: AbortSignal) {
  const res = await fetch(GOOGLE_PLACES_NEW_SEARCH_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.location,places.types,places.rating,places.userRatingCount",
    },
    body: JSON.stringify({
      textQuery: query,
      maxResultCount: limit,
    }),
  });

  if (!res.ok) throw new Error("search_failed");
  const payload = (await res.json()) as GooglePlacesSearchResponse;
  if (payload.error?.message) throw new Error("search_failed");
  return Array.isArray(payload.places) ? payload.places : [];
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const city = toNormalizedCity(body.city);
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const cityLikeQuery = isCityLikeQuery(query);
    const limit = toSafeLimit(body.limit, cityLikeQuery);

    if (!city) {
      return NextResponse.json({ error: "City is required and must be one of salem, boston, concord, nyc." }, { status: 400 });
    }
    if (query.length < MIN_QUERY_LENGTH) {
      return NextResponse.json({ error: "Query must be at least 2 characters." }, { status: 400 });
    }

    const apiKey = (process.env.GOOGLE_PLACES_API_KEY || "").trim();
    if (!apiKey) {
      return NextResponse.json({ error: "Google Places search is not configured." }, { status: 500 });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    try {
      const primaryQuery = cityLikeQuery ? `top places of interest in ${query}` : query;
      let places = await runTextSearch(primaryQuery, limit, apiKey, controller.signal);
      if (cityLikeQuery && places.length === 0) {
        places = await runTextSearch(`top tourist attractions in ${query}`, limit, apiKey, controller.signal);
      }
      if (places.length === 0) {
        return NextResponse.json({ candidates: [] });
      }

      if (cityLikeQuery) {
        places = places
          .map((place, idx) => ({ place, idx, score: poiScore(place) }))
          .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
          .map((entry) => entry.place);
      }

      const candidates: CandidateStop[] = [];
      const seenPlaceIds = new Set<string>();
      const seenCoordKeys = new Set<string>();
      const placeholder = cityPlaceholderImage(city);

      for (const place of places) {
        const title = (place.displayName?.text || "").trim();
        const lat = Number(place.location?.latitude);
        const lng = Number(place.location?.longitude);
        const googlePlaceId = (place.id || "").trim();
        if (!title || !isFiniteCoord(lat, lng)) continue;

        if (isValidGooglePlaceId(googlePlaceId)) {
          if (seenPlaceIds.has(googlePlaceId)) continue;
          seenPlaceIds.add(googlePlaceId);
        } else {
          const coordKey = `${lat.toFixed(6)},${lng.toFixed(6)}`;
          if (seenCoordKeys.has(coordKey)) continue;
          seenCoordKeys.add(coordKey);
        }

        candidates.push({
          id: toStopId(googlePlaceId, lat, lng),
          title,
          lat,
          lng,
          image: placeholder,
          ...(isValidGooglePlaceId(googlePlaceId) ? { googlePlaceId } : {}),
        });
        if (candidates.length >= limit) break;
      }

      return NextResponse.json({ candidates });
    } catch {
      return NextResponse.json({ error: "Place search failed." }, { status: 500 });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
}

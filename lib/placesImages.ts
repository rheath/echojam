const PLACEHOLDER_BY_CITY: Record<string, string> = {
  salem: "/images/salem/placeholder.png",
  boston: "/images/salem/placeholder.png",
  concord: "/images/salem/placeholder.png",
  nyc: "/images/salem/placeholder.png",
};

const GOOGLE_TEXT_SEARCH_NEW_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_IMAGE_PROXY_PATH = "/api/google-image";

const GOOGLE_PLACE_PHOTO_MAX_WIDTH_DEFAULT = 1400;
const GOOGLE_STREETVIEW_SIZE_DEFAULT = "1200x675";
const SEARCH_RADIUS_METERS = 1500;

type ResolveInput = {
  title: string;
  lat: number;
  lng: number;
  city: string;
};

export type PlaceImageResult = {
  imageUrl: string;
  googlePlaceId: string;
};

export type PlaceDetailsResult = {
  title: string;
  lat: number;
  lng: number;
  imageUrl: string;
  googlePlaceId: string;
};

type GooglePlaceNew = {
  id?: string;
  name?: string;
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  photos?: Array<{ name?: string }>;
};

type GooglePlacesNewResponse = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
  places?: GooglePlaceNew[];
};

export function cityPlaceholderImage(city: string | null | undefined) {
  const key = (city || "").toLowerCase();
  return PLACEHOLDER_BY_CITY[key] || PLACEHOLDER_BY_CITY.salem;
}

function normalize(value: string | null | undefined) {
  return (value || "").trim();
}

export function isValidGooglePlaceId(value: string | null | undefined) {
  const id = normalize(value);
  if (!id) return false;
  return !id.toLowerCase().startsWith("pexels:");
}

function getGooglePhotoMaxWidth() {
  const raw = Number.parseInt((process.env.GOOGLE_PLACE_PHOTO_MAX_WIDTH || "").trim(), 10);
  if (!Number.isFinite(raw) || raw <= 0) return GOOGLE_PLACE_PHOTO_MAX_WIDTH_DEFAULT;
  return raw;
}

function buildGoogleImageProxyUrl(params: Record<string, string>) {
  const search = new URLSearchParams(params);
  return `${GOOGLE_IMAGE_PROXY_PATH}?${search.toString()}`;
}

export function buildGooglePlacePhotoUrl(photoName: string) {
  const params = new URLSearchParams({
    maxWidthPx: String(getGooglePhotoMaxWidth()),
  });
  return buildGoogleImageProxyUrl({
    kind: "place-photo",
    name: photoName,
    maxWidthPx: params.get("maxWidthPx") || String(GOOGLE_PLACE_PHOTO_MAX_WIDTH_DEFAULT),
  });
}

export function buildGooglePlaceIdPhotoUrl(placeId: string) {
  const params = new URLSearchParams({
    maxWidthPx: String(getGooglePhotoMaxWidth()),
  });
  return buildGoogleImageProxyUrl({
    kind: "place-id-photo",
    placeId,
    maxWidthPx: params.get("maxWidthPx") || String(GOOGLE_PLACE_PHOTO_MAX_WIDTH_DEFAULT),
  });
}

export function buildGoogleStreetViewUrl(lat: number, lng: number) {
  return buildGoogleImageProxyUrl({
    kind: "streetview",
    location: `${lat},${lng}`,
    size: GOOGLE_STREETVIEW_SIZE_DEFAULT,
  });
}

function maybeProxyDirectGoogleImageUrl(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  if (parsed.hostname === "places.googleapis.com" && parsed.pathname.startsWith("/v1/") && parsed.pathname.endsWith("/media")) {
    const photoName = decodeURIComponent(parsed.pathname.slice("/v1/".length, -"/media".length));
    if (!photoName) return rawUrl;
    return buildGoogleImageProxyUrl({
      kind: "place-photo",
      name: photoName,
      maxWidthPx: parsed.searchParams.get("maxWidthPx") || String(getGooglePhotoMaxWidth()),
    });
  }

  if (parsed.hostname === "maps.googleapis.com" && parsed.pathname === "/maps/api/streetview") {
    const location = normalize(parsed.searchParams.get("location"));
    if (!location) return rawUrl;
    return buildGoogleImageProxyUrl({
      kind: "streetview",
      location,
      size: normalize(parsed.searchParams.get("size")) || GOOGLE_STREETVIEW_SIZE_DEFAULT,
    });
  }

  return rawUrl;
}

export function proxyGoogleImageUrl(value: string | null | undefined) {
  const normalized = normalize(value);
  if (!normalized) return normalized;
  if (normalized.startsWith("/")) return normalized;
  return maybeProxyDirectGoogleImageUrl(normalized);
}

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

function titleMatchScore(title: string, candidateName: string) {
  const t = normalize(title).toLowerCase();
  const c = normalize(candidateName).toLowerCase();
  if (!t || !c) return 0;
  if (c === t) return 40;
  if (c.includes(t) || t.includes(c)) return 20;

  const tTokens = new Set(t.split(/\s+/).filter(Boolean));
  const cTokens = c.split(/\s+/).filter(Boolean);
  let overlap = 0;
  for (const token of cTokens) {
    if (tTokens.has(token)) overlap += 1;
  }
  return overlap * 4;
}

async function fetchGooglePlacesNew(
  apiKey: string,
  body: {
    textQuery: string;
    locationBias?: {
      circle: {
        center: { latitude: number; longitude: number };
        radius: number;
      };
    };
    pageSize?: number;
  }
): Promise<GooglePlacesNewResponse | null> {
  const res = await fetch(GOOGLE_TEXT_SEARCH_NEW_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.name,places.displayName,places.location,places.photos",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const payload = (await res.json()) as GooglePlacesNewResponse;
  if (payload.error) return null;
  if (!Array.isArray(payload.places) || payload.places.length === 0) return null;
  return payload;
}

function placeIdFromNewPlace(place: GooglePlaceNew) {
  const id = normalize(place.id);
  if (id) return id;
  const resourceName = normalize(place.name);
  if (resourceName.startsWith("places/")) return resourceName.slice("places/".length);
  return "";
}

function pickBestPlace(
  places: GooglePlaceNew[],
  input: ResolveInput
): { place: GooglePlaceNew; photoName: string; score: number } | null {
  let best: { place: GooglePlaceNew; photoName: string; score: number } | null = null;

  for (const place of places) {
    const placeId = placeIdFromNewPlace(place);
    const name = normalize(place.displayName?.text);
    const photoName = normalize(place.photos?.[0]?.name);
    if (!isValidGooglePlaceId(placeId) || !name || !photoName) continue;

    const pLat = Number(place.location?.latitude);
    const pLng = Number(place.location?.longitude);
    const hasCoord = isFiniteCoord(pLat, pLng);
    const distPenalty = hasCoord ? distanceMeters(input.lat, input.lng, pLat, pLng) / 50 : 0;
    const score = titleMatchScore(input.title, name) - distPenalty;

    if (!best || score > best.score) {
      best = { place, photoName, score };
    }
  }

  return best;
}

async function resolveFromTextSearch(apiKey: string, input: ResolveInput) {
  const withLocationBias = await fetchGooglePlacesNew(apiKey, {
    textQuery: input.title,
    locationBias: {
      circle: {
        center: { latitude: input.lat, longitude: input.lng },
        radius: SEARCH_RADIUS_METERS,
      },
    },
    pageSize: 10,
  });

  const withCityFallback = await fetchGooglePlacesNew(apiKey, {
    textQuery: `${input.title} ${input.city}`,
    pageSize: 10,
  });

  const pooled = [
    ...(withLocationBias?.places ?? []),
    ...(withCityFallback?.places ?? []),
  ];

  if (pooled.length === 0) return null;
  return pickBestPlace(pooled, input);
}

export async function resolvePlaceImage(input: ResolveInput): Promise<PlaceImageResult | null> {
  const resolved = await resolvePlaceDetails(input);
  if (!resolved) return null;
  return {
    imageUrl: resolved.imageUrl,
    googlePlaceId: resolved.googlePlaceId,
  };
}

export async function resolvePlaceDetails(input: ResolveInput): Promise<PlaceDetailsResult | null> {
  const apiKey = normalize(process.env.GOOGLE_PLACES_API_KEY);
  if (!apiKey) return null;

  const selected = await resolveFromTextSearch(apiKey, input);
  if (!selected) return null;

  const googlePlaceId = placeIdFromNewPlace(selected.place);
  if (!isValidGooglePlaceId(googlePlaceId)) return null;
  const title = normalize(selected.place.displayName?.text);
  const lat = Number(selected.place.location?.latitude);
  const lng = Number(selected.place.location?.longitude);
  if (!title || !isFiniteCoord(lat, lng)) return null;

  return {
    title,
    lat,
    lng,
    imageUrl: buildGooglePlacePhotoUrl(selected.photoName),
    googlePlaceId,
  };
}

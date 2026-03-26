import {
  buildGooglePlaceIdPhotoUrl,
  isValidGooglePlaceId,
} from "@/lib/placesImages";
import {
  buildPlaceLocationLabel,
  type GooglePlaceAddressComponent,
} from "@/lib/server/placeLocationLabel";

export type GooglePlaceSearchCandidate = {
  id?: string;
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  addressComponents?: GooglePlaceAddressComponent[];
  formattedAddress?: string;
};

export type MixedComposerPlaceCandidate = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  image: string;
  locationLabel: string | null;
  googlePlaceId?: string;
};

function isFiniteCoord(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function toStopId(placeId: string, lat: number, lng: number) {
  if (isValidGooglePlaceId(placeId)) return `ext-gplace-${placeId}`;
  return `ext-search-${lat.toFixed(6)},${lng.toFixed(6)}`;
}

function toStopCoordKey(lat: number, lng: number) {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export function buildMixedComposerPlaceCandidate(
  place: GooglePlaceSearchCandidate,
  fallbackImage: string
): MixedComposerPlaceCandidate | null {
  const title = (place.displayName?.text || "").trim();
  const lat = Number(place.location?.latitude);
  const lng = Number(place.location?.longitude);
  const googlePlaceId = (place.id || "").trim();

  if (!title || !isFiniteCoord(lat, lng)) return null;

  return {
    id: toStopId(googlePlaceId, lat, lng),
    title,
    lat,
    lng,
    image: isValidGooglePlaceId(googlePlaceId)
      ? buildGooglePlaceIdPhotoUrl(googlePlaceId)
      : fallbackImage,
    locationLabel: buildPlaceLocationLabel({
      addressComponents: place.addressComponents,
      formattedAddress: place.formattedAddress,
    }),
    ...(isValidGooglePlaceId(googlePlaceId) ? { googlePlaceId } : {}),
  };
}

export function buildMixedComposerPlaceCandidates(
  places: GooglePlaceSearchCandidate[],
  fallbackImage: string,
  limit: number
) {
  const candidates: MixedComposerPlaceCandidate[] = [];
  const seenPlaceIds = new Set<string>();
  const seenCoordKeys = new Set<string>();

  for (const place of places) {
    const candidate = buildMixedComposerPlaceCandidate(place, fallbackImage);
    if (!candidate) continue;

    if (candidate.googlePlaceId && isValidGooglePlaceId(candidate.googlePlaceId)) {
      if (seenPlaceIds.has(candidate.googlePlaceId)) continue;
      seenPlaceIds.add(candidate.googlePlaceId);
    } else {
      const coordKey = toStopCoordKey(candidate.lat, candidate.lng);
      if (seenCoordKeys.has(coordKey)) continue;
      seenCoordKeys.add(coordKey);
    }

    candidates.push(candidate);
    if (candidates.length >= limit) break;
  }

  return candidates;
}

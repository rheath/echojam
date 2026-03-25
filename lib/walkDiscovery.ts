import type { NearbyPlaceCandidate } from "@/lib/nearbyPlaceResolver";

export type WalkDiscoveryStatus =
  | "suggested"
  | "accepted"
  | "rejected"
  | "expired";

export type WalkDiscoveryPositionSample = {
  lat: number;
  lng: number;
  timestamp: number;
};

export type WalkDiscoverySuggestion = {
  status: WalkDiscoveryStatus;
  candidateKey: string;
  id: string;
  title: string;
  lat: number;
  lng: number;
  image: string;
  source: NearbyPlaceCandidate["source"];
  googlePlaceId?: string | null;
  offeredAt: number;
  expiresAt: number;
  distanceMeters: number | null;
  isIncluded: boolean;
  isFree: boolean;
  amountUsdCents: number | null;
  priceLabel: string;
  purchaseKey: string;
};

export type WalkDiscoveryCandidate = NearbyPlaceCandidate & {
  candidateKey: string;
};

export const WALK_DISCOVERY_PRIMARY_RADIUS_METERS = 350;
export const WALK_DISCOVERY_FALLBACK_RADIUS_METERS = 700;
export const WALK_DISCOVERY_FETCH_MIN_MOVE_METERS = 35;
export const WALK_DISCOVERY_DIRECTION_MIN_MOVE_METERS = 25;
export const WALK_DISCOVERY_MIN_DISTANCE_FROM_ACCEPTED_METERS = 75;
export const WALK_DISCOVERY_EXPIRE_DISTANCE_METERS = 300;
export const WALK_DISCOVERY_EXPIRY_MS = 7 * 60 * 1000;
export const WALK_DISCOVERY_COOLDOWN_MS = 30 * 60 * 1000;
export const WALK_DISCOVERY_RECENT_POSITIONS_LIMIT = 5;

export function walkDiscoveryDistanceMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
) {
  const avgLatRad = ((aLat + bLat) / 2) * (Math.PI / 180);
  const metersPerLat = 111_320;
  const metersPerLng = 111_320 * Math.cos(avgLatRad);
  const dLat = (aLat - bLat) * metersPerLat;
  const dLng = (aLng - bLng) * metersPerLng;
  return Math.hypot(dLat, dLng);
}

export function buildWalkDiscoveryCandidateKey(candidate: {
  title: string;
  lat: number;
  lng: number;
  googlePlaceId?: string | null;
}) {
  const placeId = (candidate.googlePlaceId || "").trim().toLowerCase();
  if (placeId) return `place:${placeId}`;

  return `coord:${candidate.lat.toFixed(5)}:${candidate.lng.toFixed(5)}:${candidate.title
    .trim()
    .toLowerCase()}`;
}

export function toWalkDiscoveryCandidate(
  candidate: NearbyPlaceCandidate
): WalkDiscoveryCandidate {
  return {
    ...candidate,
    candidateKey: buildWalkDiscoveryCandidateKey(candidate),
  };
}

export function createWalkDiscoverySuggestion(
  candidate: WalkDiscoveryCandidate,
  now = Date.now(),
  pricing?: {
    isIncluded: boolean;
    isFree: boolean;
    amountUsdCents: number | null;
    priceLabel: string;
    purchaseKey: string;
  }
): WalkDiscoverySuggestion {
  return {
    status: "suggested",
    candidateKey: candidate.candidateKey,
    id: candidate.id,
    title: candidate.title,
    lat: candidate.lat,
    lng: candidate.lng,
    image: candidate.image,
    source: candidate.source,
    googlePlaceId: candidate.googlePlaceId ?? null,
    offeredAt: now,
    expiresAt: now + WALK_DISCOVERY_EXPIRY_MS,
    distanceMeters: candidate.distanceMeters ?? null,
    isIncluded: pricing?.isIncluded ?? false,
    isFree: pricing?.isFree ?? true,
    amountUsdCents: pricing?.amountUsdCents ?? null,
    priceLabel: pricing?.priceLabel ?? "Free",
    purchaseKey: pricing?.purchaseKey ?? candidate.candidateKey,
  };
}

export function pruneWalkDiscoveryCooldowns(
  cooldowns: Record<string, number>,
  now = Date.now()
) {
  const next: Record<string, number> = {};
  for (const [key, until] of Object.entries(cooldowns)) {
    if (typeof until !== "number" || !Number.isFinite(until) || until <= now) {
      continue;
    }
    next[key] = until;
  }
  return next;
}

export function shouldExpireWalkDiscoverySuggestion(args: {
  suggestion: Pick<WalkDiscoverySuggestion, "lat" | "lng" | "expiresAt">;
  currentPosition?: { lat: number; lng: number } | null;
  now?: number;
}) {
  const now = args.now ?? Date.now();
  if (now >= args.suggestion.expiresAt) return true;
  if (!args.currentPosition) return false;

  return (
    walkDiscoveryDistanceMeters(
      args.currentPosition.lat,
      args.currentPosition.lng,
      args.suggestion.lat,
      args.suggestion.lng
    ) > WALK_DISCOVERY_EXPIRE_DISTANCE_METERS
  );
}

export function appendWalkDiscoveryPosition(
  samples: WalkDiscoveryPositionSample[],
  next: WalkDiscoveryPositionSample
) {
  if (!Number.isFinite(next.lat) || !Number.isFinite(next.lng)) return samples;

  const last = samples[samples.length - 1];
  if (
    last &&
    walkDiscoveryDistanceMeters(last.lat, last.lng, next.lat, next.lng) < 3
  ) {
    const merged = [...samples];
    merged[merged.length - 1] = next;
    return merged;
  }

  return [...samples, next].slice(-WALK_DISCOVERY_RECENT_POSITIONS_LIMIT);
}

function toProjectedMeters(
  origin: { lat: number; lng: number },
  point: { lat: number; lng: number }
) {
  const avgLatRad = ((origin.lat + point.lat) / 2) * (Math.PI / 180);
  return {
    x: (point.lng - origin.lng) * 111_320 * Math.cos(avgLatRad),
    y: (point.lat - origin.lat) * 111_320,
  };
}

export function deriveWalkDiscoveryMovementVector(
  recentPositions: WalkDiscoveryPositionSample[]
) {
  if (recentPositions.length < 2) return null;

  const end = recentPositions[recentPositions.length - 1];
  for (let idx = recentPositions.length - 2; idx >= 0; idx -= 1) {
    const candidate = recentPositions[idx];
    const distance = walkDiscoveryDistanceMeters(
      candidate.lat,
      candidate.lng,
      end.lat,
      end.lng
    );
    if (distance < WALK_DISCOVERY_DIRECTION_MIN_MOVE_METERS) continue;
    const projected = toProjectedMeters(candidate, end);
    const magnitude = Math.hypot(projected.x, projected.y);
    if (magnitude < WALK_DISCOVERY_DIRECTION_MIN_MOVE_METERS) continue;
    return {
      dx: projected.x,
      dy: projected.y,
      magnitude,
    };
  }
  return null;
}

export function selectWalkDiscoveryCandidate(args: {
  candidates: NearbyPlaceCandidate[];
  currentPosition: { lat: number; lng: number };
  recentPositions?: WalkDiscoveryPositionSample[];
  excludedCandidateKeys?: string[];
  radiusMeters: number;
}) {
  const excluded = new Set(args.excludedCandidateKeys ?? []);
  const movement = deriveWalkDiscoveryMovementVector(args.recentPositions ?? []);

  const scored = args.candidates
    .map(toWalkDiscoveryCandidate)
    .filter((candidate) => {
      if (excluded.has(candidate.candidateKey)) return false;
      const distance =
        candidate.distanceMeters ??
        walkDiscoveryDistanceMeters(
          args.currentPosition.lat,
          args.currentPosition.lng,
          candidate.lat,
          candidate.lng
        );
      if (distance > args.radiusMeters) return false;
      return true;
    })
    .map((candidate) => {
      const distance =
        candidate.distanceMeters ??
        walkDiscoveryDistanceMeters(
          args.currentPosition.lat,
          args.currentPosition.lng,
          candidate.lat,
          candidate.lng
        );

      if (!movement) {
        return { candidate, score: distance };
      }

      const projected = toProjectedMeters(args.currentPosition, candidate);
      const magnitude = Math.hypot(projected.x, projected.y);
      if (magnitude < 1) {
        return { candidate, score: distance + 5 };
      }
      const cosine =
        (movement.dx * projected.x + movement.dy * projected.y) /
        (movement.magnitude * magnitude);
      if (cosine < -0.5) return null;

      const headingPenalty =
        cosine < 0 ? 400 : cosine < 0.5 ? 90 : 0;
      const lateralPenalty = Math.max(0, (1 - Math.max(cosine, 0)) * 40);

      return {
        candidate,
        score: distance + headingPenalty + lateralPenalty,
      };
    })
    .filter((entry): entry is { candidate: WalkDiscoveryCandidate; score: number } => Boolean(entry))
    .sort((a, b) => a.score - b.score);

  return scored[0]?.candidate ?? null;
}

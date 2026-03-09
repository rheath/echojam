import {
  buildGooglePlaceIdPhotoUrl,
  buildGoogleStreetViewUrl,
  cityPlaceholderImage,
} from "@/lib/placesImages";
import type { NearbyPlaceCandidate } from "@/lib/nearbyPlaceResolver";
import type { PreparedCustomRouteStop } from "@/lib/customRouteGeneration";

export type LatLng = {
  lat: number;
  lng: number;
};

export type FollowAlongLocation = LatLng & {
  label: string;
  subtitle?: string | null;
  placeId?: string | null;
};

export type FollowAlongRoutePreview = {
  origin: FollowAlongLocation;
  destination: FollowAlongLocation;
  routeCoords: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
};

export type FollowAlongSamplePoint = LatLng & {
  distanceAlongMeters: number;
};

export type FollowAlongCandidate = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  image: string;
  googlePlaceId?: string;
  distanceAlongRouteMeters: number;
  distanceFromRouteMeters: number;
  distanceFromSampleMeters: number;
  sampleIndex: number;
};

export type FollowAlongProgress = {
  distanceAlongMeters: number;
  distanceToRouteMeters: number;
};

const DEFAULT_TRIGGER_SPEED_MPS = 13.4112;
const FOLLOW_ALONG_TRIGGER_SECONDS = 45;
const MIN_TRIGGER_RADIUS_METERS = 250;
const MAX_TRIGGER_RADIUS_METERS = 800;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function approxDistanceMeters(a: LatLng, b: LatLng) {
  const avgLatRad = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const metersPerLat = 111_320;
  const metersPerLng = 111_320 * Math.cos(avgLatRad);
  const dLat = (a.lat - b.lat) * metersPerLat;
  const dLng = (a.lng - b.lng) * metersPerLng;
  return Math.hypot(dLat, dLng);
}

export function decodeGooglePolyline(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lng / 1e5, lat / 1e5]);
  }

  return coords;
}

export function cumulativeRouteDistances(routeCoords: [number, number][]) {
  const distances = [0];
  for (let idx = 1; idx < routeCoords.length; idx += 1) {
    const prev = routeCoords[idx - 1];
    const current = routeCoords[idx];
    const segmentDistance = approxDistanceMeters(
      { lat: prev[1], lng: prev[0] },
      { lat: current[1], lng: current[0] }
    );
    distances.push(distances[idx - 1] + segmentDistance);
  }
  return distances;
}

function interpolateOnSegment(
  a: [number, number],
  b: [number, number],
  ratio: number
): [number, number] {
  return [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
}

export function sampleRoutePoints(
  routeCoords: [number, number][],
  intervalMeters: number,
  startOffsetMeters = 0,
  endBufferMeters = 0
): FollowAlongSamplePoint[] {
  if (routeCoords.length < 2) return [];
  const cumulative = cumulativeRouteDistances(routeCoords);
  const totalDistance = cumulative[cumulative.length - 1] ?? 0;
  if (!Number.isFinite(totalDistance) || totalDistance <= 0) return [];

  const samples: FollowAlongSamplePoint[] = [];
  for (
    let target = Math.max(0, startOffsetMeters);
    target < Math.max(0, totalDistance - endBufferMeters);
    target += Math.max(1, intervalMeters)
  ) {
    let segmentIndex = 1;
    while (segmentIndex < cumulative.length && cumulative[segmentIndex] < target) {
      segmentIndex += 1;
    }
    if (segmentIndex >= cumulative.length) break;
    const segmentStartDistance = cumulative[segmentIndex - 1];
    const segmentEndDistance = cumulative[segmentIndex];
    const segmentLength = Math.max(1, segmentEndDistance - segmentStartDistance);
    const ratio = clamp(
      (target - segmentStartDistance) / segmentLength,
      0,
      1
    );
    const point = interpolateOnSegment(
      routeCoords[segmentIndex - 1],
      routeCoords[segmentIndex],
      ratio
    );
    samples.push({
      lat: point[1],
      lng: point[0],
      distanceAlongMeters: target,
    });
  }

  return samples;
}

export function projectPointOntoRoute(
  point: LatLng,
  routeCoords: [number, number][]
): FollowAlongProgress {
  if (routeCoords.length < 2) {
    return { distanceAlongMeters: 0, distanceToRouteMeters: Number.POSITIVE_INFINITY };
  }

  const cumulative = cumulativeRouteDistances(routeCoords);
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestDistanceAlong = 0;

  for (let idx = 1; idx < routeCoords.length; idx += 1) {
    const a = routeCoords[idx - 1];
    const b = routeCoords[idx];
    const avgLatRad = ((a[1] + b[1]) / 2) * (Math.PI / 180);
    const scaleX = 111_320 * Math.cos(avgLatRad);
    const scaleY = 111_320;
    const ax = a[0] * scaleX;
    const ay = a[1] * scaleY;
    const bx = b[0] * scaleX;
    const by = b[1] * scaleY;
    const px = point.lng * scaleX;
    const py = point.lat * scaleY;
    const dx = bx - ax;
    const dy = by - ay;
    const denom = dx * dx + dy * dy;
    const t = denom > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / denom, 0, 1) : 0;
    const projX = ax + dx * t;
    const projY = ay + dy * t;
    const dist = Math.hypot(px - projX, py - projY);

    if (dist < bestDistance) {
      bestDistance = dist;
      const segmentLength = cumulative[idx] - cumulative[idx - 1];
      bestDistanceAlong = cumulative[idx - 1] + segmentLength * t;
    }
  }

  return {
    distanceAlongMeters: bestDistanceAlong,
    distanceToRouteMeters: bestDistance,
  };
}

export function computeTriggerRadiusMeters(speedMps?: number | null) {
  const effectiveSpeed =
    typeof speedMps === "number" && Number.isFinite(speedMps) && speedMps > 0
      ? speedMps
      : DEFAULT_TRIGGER_SPEED_MPS;
  return clamp(
    effectiveSpeed * FOLLOW_ALONG_TRIGGER_SECONDS,
    MIN_TRIGGER_RADIUS_METERS,
    MAX_TRIGGER_RADIUS_METERS
  );
}

function candidateKey(candidate: { googlePlaceId?: string | null; lat: number; lng: number; title: string }) {
  const placeId = (candidate.googlePlaceId || "").trim().toLowerCase();
  if (placeId) return `place:${placeId}`;
  return `coord:${candidate.lat.toFixed(5)}:${candidate.lng.toFixed(5)}:${candidate.title.trim().toLowerCase()}`;
}

export function buildRouteCandidates(
  routeCoords: [number, number][],
  samples: FollowAlongSamplePoint[],
  sampleCandidates: NearbyPlaceCandidate[][]
): FollowAlongCandidate[] {
  const candidates: FollowAlongCandidate[] = [];
  for (let sampleIdx = 0; sampleIdx < samples.length; sampleIdx += 1) {
    const sample = samples[sampleIdx];
    const group = sampleCandidates[sampleIdx] ?? [];
    for (const candidate of group) {
      const progress = projectPointOntoRoute(
        { lat: candidate.lat, lng: candidate.lng },
        routeCoords
      );
      candidates.push({
        id: candidate.id,
        title: candidate.title,
        lat: candidate.lat,
        lng: candidate.lng,
        image: candidate.image,
        googlePlaceId: candidate.googlePlaceId ?? undefined,
        distanceAlongRouteMeters: progress.distanceAlongMeters,
        distanceFromRouteMeters: progress.distanceToRouteMeters,
        distanceFromSampleMeters:
          typeof candidate.distanceMeters === "number" &&
          Number.isFinite(candidate.distanceMeters)
            ? candidate.distanceMeters
            : approxDistanceMeters(sample, {
                lat: candidate.lat,
                lng: candidate.lng,
              }),
        sampleIndex: sampleIdx,
      });
    }
  }
  return candidates;
}

export function dedupeFollowAlongCandidates(candidates: FollowAlongCandidate[]) {
  const byKey = new Map<string, FollowAlongCandidate>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }

    const existingScore =
      existing.distanceFromRouteMeters + existing.distanceFromSampleMeters * 0.5;
    const incomingScore =
      candidate.distanceFromRouteMeters + candidate.distanceFromSampleMeters * 0.5;
    if (incomingScore < existingScore) {
      byKey.set(key, candidate);
    }
  }
  return Array.from(byKey.values());
}

export function selectStoryCandidates(
  candidates: FollowAlongCandidate[],
  maxStories: number,
  minGapMeters: number
) {
  const sorted = [...candidates].sort((a, b) => {
    if (a.distanceAlongRouteMeters !== b.distanceAlongRouteMeters) {
      return a.distanceAlongRouteMeters - b.distanceAlongRouteMeters;
    }
    return (
      a.distanceFromRouteMeters +
      a.distanceFromSampleMeters -
      (b.distanceFromRouteMeters + b.distanceFromSampleMeters)
    );
  });

  const selected: FollowAlongCandidate[] = [];
  for (const candidate of sorted) {
    if (selected.length >= maxStories) break;
    const tooClose = selected.some(
      (existing) =>
        Math.abs(
          existing.distanceAlongRouteMeters - candidate.distanceAlongRouteMeters
        ) < minGapMeters
    );
    if (tooClose) continue;
    selected.push(candidate);
  }
  return selected;
}

export function buildArrivalStop(
  destination: FollowAlongLocation,
  routeDistanceMeters: number,
  triggerRadiusMeters: number
): PreparedCustomRouteStop {
  const image =
    destination.placeId && destination.placeId.trim()
      ? buildGooglePlaceIdPhotoUrl(destination.placeId)
      : buildGoogleStreetViewUrl(destination.lat, destination.lng) ||
        cityPlaceholderImage(deriveRouteCity(destination));

  return {
    id: `follow-arrival-${destination.lat.toFixed(5)}-${destination.lng.toFixed(5)}`,
    title: destination.label,
    lat: destination.lat,
    lng: destination.lng,
    image,
    googlePlaceId: destination.placeId || undefined,
    stopKind: "arrival",
    distanceAlongRouteMeters: routeDistanceMeters,
    triggerRadiusMeters,
  };
}

export function buildFollowAlongStops(
  storyCandidates: FollowAlongCandidate[],
  destination: FollowAlongLocation,
  routeDistanceMeters: number,
  triggerRadiusMeters: number
): PreparedCustomRouteStop[] {
  const storyStops: PreparedCustomRouteStop[] = storyCandidates.map((candidate) => ({
    id: `follow-story-${candidate.sampleIndex + 1}-${candidate.id.replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
    title: candidate.title,
    lat: candidate.lat,
    lng: candidate.lng,
    image: candidate.image,
    googlePlaceId: candidate.googlePlaceId,
    stopKind: "story",
    distanceAlongRouteMeters: candidate.distanceAlongRouteMeters,
    triggerRadiusMeters,
  }));

  return [
    ...storyStops,
    buildArrivalStop(destination, routeDistanceMeters, triggerRadiusMeters),
  ];
}

export function deriveRouteCity(location: Pick<FollowAlongLocation, "label" | "subtitle">) {
  const subtitle = (location.subtitle || "").trim();
  const fromSubtitle = subtitle
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .find((part) => !/\d/.test(part) && part.length >= 3);
  if (fromSubtitle) return fromSubtitle.toLowerCase();

  const fromLabel = location.label
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)[0];
  return (fromLabel || "nearby").toLowerCase();
}

export function computeFollowAlongStoryCount(durationSeconds: number) {
  return clamp(Math.round(durationSeconds / 360), 2, 9);
}

export function normalizeRouteProgress(
  myPos: LatLng,
  routeCoords: [number, number][]
) {
  return projectPointOntoRoute(myPos, routeCoords);
}

export function nextFollowAlongStopIndex(
  currentStopIndex: number | null,
  stops: Array<{ stopKind?: string }>
) {
  const nextIndex = currentStopIndex === null ? 0 : currentStopIndex + 1;
  return clamp(nextIndex, 0, Math.max(0, stops.length - 1));
}

export function shouldTriggerFollowAlongStop(params: {
  routeCoords: [number, number][];
  myPos: LatLng;
  stop: {
    distanceAlongRouteMeters?: number | null;
    triggerRadiusMeters?: number | null;
  };
  speedMps?: number | null;
}) {
  const progress = normalizeRouteProgress(params.myPos, params.routeCoords);
  const stopDistance = Number(params.stop.distanceAlongRouteMeters);
  const triggerRadius =
    typeof params.stop.triggerRadiusMeters === "number" &&
    Number.isFinite(params.stop.triggerRadiusMeters)
      ? params.stop.triggerRadiusMeters
      : computeTriggerRadiusMeters(params.speedMps);
  if (!Number.isFinite(stopDistance)) {
    return { shouldTrigger: false, progress };
  }

  const aheadByMeters = stopDistance - progress.distanceAlongMeters;
  const shouldTrigger = aheadByMeters <= triggerRadius && aheadByMeters >= -120;
  return {
    shouldTrigger,
    aheadByMeters,
    triggerRadius,
    progress,
  };
}

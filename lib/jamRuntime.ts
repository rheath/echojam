export type JamVisibilityState = DocumentVisibilityState | "hidden" | "visible";
export type JamTrackingMode = "idle" | "walk" | "followAlongDrive";

export type GeoCommitSample = {
  lat: number;
  lng: number;
  timestamp: number;
};

export type GeoCommitConfig = {
  minElapsedMs: number;
  minDistanceMeters: number;
};

export type GeoCommitDecision = {
  shouldCommit: boolean;
  elapsedMs: number;
  distanceMeters: number;
};

export type JamPerfSnapshot = {
  elapsedMs: number;
  counters: Record<string, number>;
  timings: Record<
    string,
    {
      count: number;
      totalMs: number;
      maxMs: number;
      lastMs: number;
    }
  >;
};

type PerfLogger = (message?: unknown, ...optionalParams: unknown[]) => void;

const DEFAULT_GEO_COMMIT_CONFIG: GeoCommitConfig = {
  minElapsedMs: 4_000,
  minDistanceMeters: 15,
};

function defaultNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number) {
  const radiusMeters = 6_371_000;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const x = sinLat * sinLat + sinLng * sinLng * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return radiusMeters * c;
}

export function isJamDocumentVisible(visibilityState: JamVisibilityState | null | undefined) {
  return visibilityState !== "hidden";
}

export function shouldRunJamGeoTracking(
  mode: JamTrackingMode,
  visibilityState: JamVisibilityState | null | undefined
) {
  if (!isJamDocumentVisible(visibilityState)) return false;
  return mode === "walk" || mode === "followAlongDrive";
}

export function shouldRunWalkDiscoveryWork(
  visibilityState: JamVisibilityState | null | undefined,
  isWalkDiscoveryRoute: boolean
) {
  return isWalkDiscoveryRoute && isJamDocumentVisible(visibilityState);
}

export function shouldCommitGeoUpdate(
  previous: GeoCommitSample | null,
  next: GeoCommitSample,
  config: GeoCommitConfig = DEFAULT_GEO_COMMIT_CONFIG
): GeoCommitDecision {
  if (!previous) {
    return {
      shouldCommit: true,
      elapsedMs: Number.POSITIVE_INFINITY,
      distanceMeters: Number.POSITIVE_INFINITY,
    };
  }

  const elapsedMs = Math.max(0, next.timestamp - previous.timestamp);
  const distanceMeters = haversineMeters(previous.lat, previous.lng, next.lat, next.lng);

  return {
    shouldCommit:
      elapsedMs >= config.minElapsedMs || distanceMeters >= config.minDistanceMeters,
    elapsedMs,
    distanceMeters,
  };
}

export function createJamPerfTracker(options?: {
  enabled?: boolean;
  now?: () => number;
  logger?: PerfLogger;
}) {
  const now = options?.now ?? defaultNow;
  const logger = options?.logger ?? console.info;
  let enabled = Boolean(options?.enabled);
  let startedAt = now();
  let counters: Record<string, number> = {};
  let timings: JamPerfSnapshot["timings"] = {};

  function reset() {
    startedAt = now();
    counters = {};
    timings = {};
  }

  function snapshot(): JamPerfSnapshot | null {
    if (!enabled) return null;
    return {
      elapsedMs: Math.max(0, now() - startedAt),
      counters: { ...counters },
      timings: Object.fromEntries(
        Object.entries(timings).map(([name, summary]) => [
          name,
          { ...summary },
        ])
      ),
    };
  }

  return {
    setEnabled(nextEnabled: boolean) {
      if (enabled === nextEnabled) return;
      enabled = nextEnabled;
      if (enabled) {
        reset();
      }
    },
    count(name: string, delta = 1) {
      if (!enabled) return;
      counters[name] = (counters[name] ?? 0) + delta;
    },
    timing(name: string, durationMs: number) {
      if (!enabled) return;
      const normalizedDuration = Number.isFinite(durationMs)
        ? Math.max(0, durationMs)
        : 0;
      const current = timings[name] ?? {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        lastMs: 0,
      };
      current.count += 1;
      current.totalMs += normalizedDuration;
      current.maxMs = Math.max(current.maxMs, normalizedDuration);
      current.lastMs = normalizedDuration;
      timings[name] = current;
    },
    snapshot,
    flush(reason: string) {
      if (!enabled) return;
      logger("[EchoJamPerf]", {
        reason,
        ...snapshot(),
      });
    },
  };
}

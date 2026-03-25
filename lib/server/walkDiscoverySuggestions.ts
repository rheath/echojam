import type { SupabaseClient } from "@supabase/supabase-js";
import {
  discoveryPrimaryTypesForThemes,
  normalizeDiscoveryThemes,
  type DiscoveryTheme,
} from "@/lib/discoveryThemes";
import { resolveNearbyPlaces } from "@/lib/nearbyPlaceResolver";
import {
  buildWalkDiscoveryCandidateKey,
  selectWalkDiscoveryCandidate,
  type WalkDiscoveryExistingStop,
  type WalkDiscoveryPositionSample,
  WALK_DISCOVERY_FALLBACK_RADIUS_METERS,
  WALK_DISCOVERY_PRIMARY_RADIUS_METERS,
} from "@/lib/walkDiscovery";

const WALK_DISCOVERY_INCLUDED_PRIMARY_TYPES = [
  "tourist_attraction",
  "museum",
  "art_gallery",
  "church",
  "library",
  "park",
] as const;

export async function resolveWalkDiscoverySuggestion(args: {
  admin: SupabaseClient;
  lat: number;
  lng: number;
  recentPositions?: WalkDiscoveryPositionSample[];
  excludedCandidateKeys?: string[];
  existingRouteStops?: WalkDiscoveryExistingStop[] | null;
  city?: string | null;
  discoveryThemes?: DiscoveryTheme[] | null;
}) {
  const city = (args.city || "").trim().toLowerCase() || "nearby";
  const discoveryThemes = normalizeDiscoveryThemes(args.discoveryThemes);
  const themedPrimaryTypes = discoveryPrimaryTypesForThemes(discoveryThemes);
  const search = async (radiusMeters: number) => {
    const resolved = await resolveNearbyPlaces({
      admin: args.admin,
      city,
      lat: args.lat,
      lng: args.lng,
      radiusMeters,
      maxCandidates: 8,
      googleOnly: true,
      includedPrimaryTypes: themedPrimaryTypes ?? [...WALK_DISCOVERY_INCLUDED_PRIMARY_TYPES],
      allowBroadGoogleFallback: discoveryThemes.length > 0,
    });

    const candidate = selectWalkDiscoveryCandidate({
      candidates: resolved.candidates,
      currentPosition: { lat: args.lat, lng: args.lng },
      recentPositions: args.recentPositions,
      excludedCandidateKeys: args.excludedCandidateKeys,
      existingRouteStops: args.existingRouteStops,
      radiusMeters,
      preferredThemes: discoveryThemes,
    });

    return candidate
      ? {
          ...candidate,
          candidateKey: buildWalkDiscoveryCandidateKey(candidate),
        }
      : null;
  };

  const primary = await search(WALK_DISCOVERY_PRIMARY_RADIUS_METERS);
  if (primary) return primary;
  return search(WALK_DISCOVERY_FALLBACK_RADIUS_METERS);
}

import type { RouteDef } from "@/app/content/routeTypes";
import { isPresetOverviewStopId } from "@/lib/presetOverview";

const DEFAULT_STOP_IMAGE = "/images/salem/placeholder.png";

export type ResolvedRouteStopPayload = {
  stop_id: string;
  title: string;
  lat: number;
  lng: number;
  image_url?: string | null;
  source_provider?: "instagram" | "tiktok" | "google_places" | null;
  source_kind?: "social_import" | "place_search" | null;
  source_url?: string | null;
  source_id?: string | null;
  source_preview_image_url?: string | null;
  source_creator_name?: string | null;
  source_creator_url?: string | null;
  source_creator_avatar_url?: string | null;
  google_place_id?: string | null;
  stop_kind?: "story" | "arrival" | null;
  distance_along_route_meters?: number | null;
  trigger_radius_meters?: number | null;
  script_adult?: string | null;
  script_preteen?: string | null;
  script_ghost?: string | null;
  script_custom?: string | null;
  audio_url_adult?: string | null;
  audio_url_preteen?: string | null;
  audio_url_ghost?: string | null;
  audio_url_custom?: string | null;
  is_overview?: boolean;
};

export function toSafeResolvedRouteStopImage(value: string | null | undefined) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return DEFAULT_STOP_IMAGE;
  if (normalized.startsWith("/")) return normalized;
  if (normalized.startsWith("https://") || normalized.startsWith("http://")) return normalized;
  return DEFAULT_STOP_IMAGE;
}

export function mapResolvedRouteStops(
  stops: ResolvedRouteStopPayload[]
): RouteDef["stops"] {
  return stops.map((stop, idx) => {
    const stopId = stop.stop_id || `custom-${idx}`;
    return {
      id: stopId,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      googlePlaceId: (stop.google_place_id || "").trim() || undefined,
      sourceProvider: stop.source_provider ?? null,
      sourceKind: stop.source_kind ?? null,
      sourceUrl: stop.source_url ?? null,
      sourceId: stop.source_id ?? null,
      sourcePreviewImageUrl: stop.source_preview_image_url ?? null,
      sourceCreatorName: stop.source_creator_name ?? null,
      sourceCreatorUrl: stop.source_creator_url ?? null,
      sourceCreatorAvatarUrl: stop.source_creator_avatar_url ?? null,
      isOverview: Boolean(stop.is_overview) || isPresetOverviewStopId(stopId),
      stopKind: stop.stop_kind || "story",
      distanceAlongRouteMeters:
        typeof stop.distance_along_route_meters === "number"
          ? stop.distance_along_route_meters
          : null,
      triggerRadiusMeters:
        typeof stop.trigger_radius_meters === "number"
          ? stop.trigger_radius_meters
          : null,
      images: [toSafeResolvedRouteStopImage(stop.image_url)],
      audio: {
        adult: stop.audio_url_adult || "",
        preteen: stop.audio_url_preteen || "",
        ghost: stop.audio_url_ghost || "",
        custom: stop.audio_url_custom || "",
      },
      text: {
        adult: stop.script_adult || "",
        preteen: stop.script_preteen || "",
        ghost: stop.script_ghost || "",
        custom: stop.script_custom || "",
      },
    };
  });
}

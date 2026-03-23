import "server-only";

import { presetRouteData } from "@/app/content/generated/presetRoutes.generated";
import type {
  FixedPersona,
  Persona,
  PresetCity,
  PresetContentPriority,
  PresetNarrationBeat,
  PresetRouteVoice,
  PresetTtsVoice,
  RouteDef,
} from "@/app/content/routeTypes";
import { personaCatalog } from "@/lib/personas/catalog";

export type {
  FixedPersona,
  Persona,
  PresetCity,
  PresetContentPriority,
  PresetNarrationBeat,
  PresetRouteVoice,
  PresetTtsVoice,
  RoutePricing,
  RouteDef,
  Stop,
} from "@/app/content/routeTypes";

const DEFAULT_PLACEHOLDER = "/images/salem/placeholder.png";

function toPresetContentPriority(value: unknown): PresetContentPriority | null {
  return value === "default" || value === "history_first" ? value : null;
}

function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : null;
}

function toPresetNarrationBeat(value: unknown): PresetNarrationBeat | null {
  return value === "overview" ||
    value === "hook" ||
    value === "reveal" ||
    value === "contrast" ||
    value === "payoff"
    ? value
    : null;
}

function toPresetTtsVoice(value: unknown): PresetTtsVoice | null {
  return value === "alloy" || value === "nova" || value === "shimmer" || value === "onyx" ? value : null;
}

function toFixedPersona(value: unknown): FixedPersona | null {
  return value === "adult" || value === "preteen" || value === "ghost" ? value : null;
}

function mapRoute(route: (typeof presetRouteData.routes)[number]): RouteDef {
  const routeContentPriority = "contentPriority" in route ? toPresetContentPriority(route.contentPriority) : null;
  const routeVoice: PresetRouteVoice | null =
    "voice" in route && route.voice && typeof route.voice === "object"
      ? {
          archetypeId:
            typeof route.voice.archetypeId === "string" && route.voice.archetypeId.trim()
              ? route.voice.archetypeId.trim()
              : "default",
          displayName:
            typeof route.voice.displayName === "string" && route.voice.displayName.trim()
              ? route.voice.displayName.trim()
              : null,
          basePersona: toFixedPersona(route.voice.basePersona) ?? toFixedPersona(route.defaultPersona) ?? "adult",
          ttsVoice: toPresetTtsVoice(route.voice.ttsVoice),
          tone: normalizeStringArray(route.voice.tone),
          storyLens:
            typeof route.voice.storyLens === "string" && route.voice.storyLens.trim()
              ? route.voice.storyLens.trim()
              : null,
          transitionStyle:
            typeof route.voice.transitionStyle === "string" && route.voice.transitionStyle.trim()
              ? route.voice.transitionStyle.trim()
              : null,
          bannedPatterns: normalizeStringArray(route.voice.bannedPatterns),
          openerFamilies: normalizeStringArray(route.voice.openerFamilies),
        }
      : null;

  return {
    id: route.id,
    title: route.title,
    durationLabel: route.durationLabel,
    durationMinutes: route.durationMinutes,
    description: route.description,
    defaultPersona: route.defaultPersona,
    storyBy: "storyBy" in route ? route.storyBy : undefined,
    storyByUrl: null,
    storyByAvatarUrl: null,
    storyBySource: null,
    narratorGuidance: "narratorGuidance" in route ? route.narratorGuidance ?? null : null,
    contentPriority: routeContentPriority,
    voice: routeVoice,
    pricing: route.pricing,
    city: route.city,
    transportMode: "walk",
    experienceKind: "preset",
    routePathCoords: null,
    origin: null,
    destination: null,
    routeDistanceMeters: null,
    routeDurationSeconds: null,
    stops: route.stops.map((stop) => ({
      id: stop.id,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      googlePlaceId: stop.googlePlaceId,
      narratorGuidance:
        "narratorGuidance" in stop && typeof stop.narratorGuidance === "string" ? stop.narratorGuidance : null,
      mustMention:
        "mustMention" in stop && Array.isArray(stop.mustMention)
          ? stop.mustMention.filter((value): value is string => typeof value === "string")
          : null,
      factBullets:
        "factBullets" in stop && Array.isArray(stop.factBullets)
          ? stop.factBullets.filter((value): value is string => typeof value === "string")
          : null,
      contentPriority: "contentPriority" in stop ? toPresetContentPriority(stop.contentPriority) : routeContentPriority,
      narration:
        "narration" in stop && stop.narration && typeof stop.narration === "object"
          ? {
              beat: toPresetNarrationBeat(stop.narration.beat),
              angle:
                typeof stop.narration.angle === "string" && stop.narration.angle.trim()
                  ? stop.narration.angle.trim()
                  : null,
              factBullets: normalizeStringArray(stop.narration.factBullets),
              mustMention: normalizeStringArray(stop.narration.mustMention),
              sensoryTargets: normalizeStringArray(stop.narration.sensoryTargets),
              contentPriority: toPresetContentPriority(stop.narration.contentPriority),
            }
          : null,
      audio: { adult: "", preteen: "", ghost: "", custom: "" },
      images: [DEFAULT_PLACEHOLDER],
      stopKind: "story",
      distanceAlongRouteMeters: null,
      triggerRadiusMeters: null,
    })),
  };
}

export const presetRoutes: RouteDef[] = presetRouteData.routes.map(mapRoute);

export function getPresetRoutesByCity(city: PresetCity): RouteDef[] {
  return presetRoutes.filter((route) => route.city === city);
}

export const salemRoutes: RouteDef[] = getPresetRoutesByCity("salem");

export function getRouteById(routeId: string | null | undefined): RouteDef | null {
  if (!routeId) return null;
  const route = presetRouteData.routes.find((candidate) => candidate.id === routeId);
  if (!route) return null;
  return mapRoute(route);
}

export function getRouteNarratorLabel(route: Pick<RouteDef, "storyBy"> | null | undefined, persona: Persona) {
  const override = typeof route?.storyBy === "string" ? route.storyBy.trim() : "";
  if (override) return override;
  return personaCatalog[persona].displayName;
}

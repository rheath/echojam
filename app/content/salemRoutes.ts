import { presetRouteData } from "@/app/content/generated/presetRoutes.generated";
import { personaCatalog } from "@/lib/personas/catalog";

export type FixedPersona = "adult" | "preteen" | "ghost";
export type Persona = FixedPersona | "custom";
export type PresetCity = "salem" | "boston" | "concord" | "nyc";
export type PresetContentPriority = "default" | "history_first";
export type PresetNarrationBeat = "overview" | "hook" | "reveal" | "contrast" | "payoff";
export type PresetTtsVoice = "alloy" | "nova" | "shimmer" | "onyx";
export type RoutePricing = {
  status: "free" | "paid" | "tbd";
  displayLabel?: string;
  amountUsdCents?: number | null;
};

export type PresetRouteVoice = {
  archetypeId: string;
  displayName?: string | null;
  basePersona: FixedPersona;
  ttsVoice?: PresetTtsVoice | null;
  tone?: string[] | null;
  storyLens?: string | null;
  transitionStyle?: string | null;
  bannedPatterns?: string[] | null;
  openerFamilies?: string[] | null;
};

export type PresetStopNarration = {
  beat?: PresetNarrationBeat | null;
  angle?: string | null;
  factBullets?: string[] | null;
  mustMention?: string[] | null;
  sensoryTargets?: string[] | null;
  contentPriority?: PresetContentPriority | null;
};

export type Stop = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  googlePlaceId?: string;
  narratorGuidance?: string | null;
  mustMention?: string[] | null;
  factBullets?: string[] | null;
  contentPriority?: PresetContentPriority | null;
  narration?: PresetStopNarration | null;
  isOverview?: boolean;
  stopKind?: "story" | "arrival";
  distanceAlongRouteMeters?: number | null;
  triggerRadiusMeters?: number | null;
  audio: Record<Persona, string>;
  text?: Record<Persona, string>;
  images: string[];
};

export type RouteDef = {
  id: string;
  title: string;
  durationLabel: string;
  durationMinutes?: number;
  description: string;
  defaultPersona: Persona;
  storyBy?: string;
  storyByUrl?: string | null;
  storyByAvatarUrl?: string | null;
  storyBySource?: "instagram" | null;
  narratorGuidance?: string | null;
  contentPriority?: PresetContentPriority | null;
  voice?: PresetRouteVoice | null;
  pricing?: RoutePricing;
  city?: PresetCity;
  transportMode?: "walk" | "drive";
  experienceKind?: "preset" | "mix" | "follow_along" | "walk_discovery";
  routePathCoords?: [number, number][] | null;
  origin?: { lat: number; lng: number; label: string; subtitle?: string | null } | null;
  destination?: { lat: number; lng: number; label: string; subtitle?: string | null } | null;
  routeDistanceMeters?: number | null;
  routeDurationSeconds?: number | null;
  stops: Stop[];
};

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

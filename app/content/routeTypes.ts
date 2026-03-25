export type FixedPersona = "adult" | "preteen" | "ghost";
export type Persona = FixedPersona | "custom";
export type PresetCity = "salem" | "boston" | "concord" | "nyc";
export type PresetContentPriority = "default" | "history_first";
export type PresetNarrationBeat = "overview" | "hook" | "reveal" | "contrast" | "payoff";
export type PresetTtsVoice = "alloy" | "nova" | "shimmer" | "onyx";
export type DiscoveryTheme =
  | "history"
  | "architecture"
  | "animals"
  | "comics"
  | "weird_history"
  | "ghosts_folklore";

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
  sourceProvider?: "instagram" | "tiktok" | "google_places" | null;
  sourceKind?: "social_import" | "place_search" | null;
  sourceUrl?: string | null;
  sourceId?: string | null;
  sourceCreatorName?: string | null;
  sourceCreatorUrl?: string | null;
  sourceCreatorAvatarUrl?: string | null;
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
  discoveryThemes?: DiscoveryTheme[] | null;
  defaultPersona: Persona;
  storyBy?: string;
  storyByUrl?: string | null;
  storyByAvatarUrl?: string | null;
  storyBySource?: "instagram" | "tiktok" | "social" | null;
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

export type PresetRouteSummary = {
  id: string;
  title: string;
  durationLabel: string;
  durationMinutes?: number;
  description: string;
  discoveryThemes?: DiscoveryTheme[] | null;
  defaultPersona: Persona;
  storyBy?: string;
  pricing?: RoutePricing;
  city?: PresetCity;
  stopCount: number;
  previewImageUrl?: string | null;
  firstStopTitle?: string | null;
  previewPlaceId?: string | null;
  requiresPurchase: boolean;
  accessState: "unknown" | "granted" | "locked";
};

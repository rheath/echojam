"use client";
 
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { Bangers, Bree_Serif, Cinzel, Forum, Grenze, Schoolbell, Special_Elite } from "next/font/google";
import { supabase } from "@/lib/supabaseClient";
import {
  getPresetRoutesByCity,
  getRouteById,
  getRouteNarratorLabel,
  type Persona,
  type PresetCity,
  type RouteDef,
  type RoutePricing,
} from "@/app/content/salemRoutes";
import { buildPresetOverviewStop, getPresetCityMeta, isPresetOverviewStopId } from "@/lib/presetOverview";
import { personaCatalog } from "@/lib/personas/catalog";
import { getMaxStops, validateMixSelection } from "@/lib/mixConstraints";
import {
  nextFollowAlongStopIndex,
  normalizeRouteProgress,
  shouldTriggerFollowAlongStop,
  type FollowAlongLocation,
} from "@/lib/followAlong";
import dynamic from "next/dynamic";
import styles from "./HomeClient.module.css";

const RouteMap = dynamic(() => import("./components/RouteMap"), { ssr: false });
const SCRIPT_MODAL_EXIT_MS = 240;

const landingRevolutionaryFont = Cinzel({
  subsets: ["latin"],
  weight: ["600", "700"],
});

const landingTavernsFont = Bree_Serif({
  subsets: ["latin"],
  weight: "400",
});

const landingArchitectureFont = Forum({
  subsets: ["latin"],
  weight: "400",
});

const landingSalemFont = Grenze({
  subsets: ["latin"],
  weight: ["500", "600"],
});

const landingAnimalsFont = Schoolbell({
  subsets: ["latin"],
  weight: "400",
});

const landingSuperheroFont = Bangers({
  subsets: ["latin"],
  weight: "400",
});

const landingWeirdHistoryFont = Special_Elite({
  subsets: ["latin"],
  weight: "400",
});


type JamRow = {
  id: string;
  host_name: string | null;

  // New MVP fields
  route_id: string | null;
  persona: Persona | null;
  current_stop: number | null;
  completed_at: string | null;

  // Legacy fields (keep if present in table)
  is_playing?: boolean | null;
  position_ms?: number | null;
  listen_count?: number | null;
};

type FlowStep =
  | "landing"
  | "pickDuration"
  | "buildMix"
  | "followAlongSetup"
  | "generating"
  | "walk"
  | "followAlongDrive"
  | "end";
type PickDurationPage = "narrator" | "routes";
type NarratorFlowSource = "buildMix" | "followAlong" | "walkEdit" | null;
type CityOption = PresetCity;
type TransportMode = "walk" | "drive";
type LandingTheme = "dark" | "light";

type CustomMixStop = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  image: string;
  googlePlaceId?: string;
};

type CustomRouteResponse = {
  route: {
    id: string;
    title: string;
    city?: string | null;
    length_minutes: number;
    transport_mode: TransportMode;
    experience_kind?: "mix" | "follow_along" | null;
    status: "queued" | "generating" | "generating_script" | "generating_audio" | "ready" | "ready_with_warnings" | "failed";
    narrator_default?: Persona | null;
    narrator_guidance?: string | null;
    narrator_voice?: string | null;
    origin_label?: string | null;
    origin_lat?: number | null;
    origin_lng?: number | null;
    destination_label?: string | null;
    destination_lat?: number | null;
    destination_lng?: number | null;
    route_distance_meters?: number | null;
    route_duration_seconds?: number | null;
    route_polyline?: [number, number][] | null;
    story_by?: string | null;
    story_by_url?: string | null;
    story_by_avatar_url?: string | null;
    story_by_source?: "instagram" | null;
  };
  stops: Array<{
    stop_id: string;
    title: string;
    lat: number;
    lng: number;
    image_url: string | null;
    stop_kind?: "story" | "arrival" | null;
    distance_along_route_meters?: number | null;
    trigger_radius_meters?: number | null;
    script_adult: string | null;
    script_preteen: string | null;
    script_ghost: string | null;
    script_custom?: string | null;
    audio_url_adult: string | null;
    audio_url_preteen: string | null;
    audio_url_ghost: string | null;
    audio_url_custom?: string | null;
    is_overview?: boolean;
    position: number;
  }>;
};

type MixJobResponse = {
  id: string;
  status: "queued" | "generating_script" | "generating_audio" | "ready" | "ready_with_warnings" | "failed";
  progress: number;
  message: string | null;
  error: string | null;
  jam_id: string;
  route_id: string;
  updated_at?: string | null;
};

type GenerationJobKind = "custom" | "preset";
type ActiveGenerationJobRow = {
  id: string;
  status: MixJobResponse["status"];
};

type SearchPlacesResponse = {
  candidates: CustomMixStop[];
};

type FollowAlongSearchResponse = {
  results: Array<
    FollowAlongLocation & {
      title: string;
      types: string[];
    }
  >;
};

type FollowAlongOriginResponse = {
  origin: FollowAlongLocation;
};

type FollowAlongPreviewResponse = {
  origin: FollowAlongLocation;
  destination: FollowAlongLocation;
  routeCoords: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
};

type NearbyPlacesResponse = {
  stops: CustomMixStop[];
  cityUsed: string;
  sourceSummary: Record<string, number>;
};

type StartCustomMixOptions = {
  source?: "manual" | "instant";
  routeTitle?: string;
  errorStep?: FlowStep;
  cityOverride?: string;
  narratorGuidance?: string | null;
};

type StartPresetTourOptions = {
  forceRegenerateAll?: boolean;
};

const GENERATION_STATUS_LABELS: Record<MixJobResponse["status"], string> = {
  queued: "Queued",
  generating_script: "Creating the curated story",
  generating_audio: "Recording the audio",
  ready: "Ready",
  ready_with_warnings: "Ready with warnings",
  failed: "Failed",
};

const POLL_INTERVAL_MS = 1500;
const POLL_REQUEST_TIMEOUT_MS = 8000;
const POLL_FAILURE_THRESHOLD = 5;
const START_JOB_TIMEOUT_MS = 15000;
const FOLLOW_ALONG_ORIGIN_PENDING_SUBTITLE = "Finding address...";
const FOLLOW_ALONG_ORIGIN_FALLBACK_SUBTITLE = "Location detected";
const PERSONA_KEYS: Array<Exclude<Persona, "custom">> = ["adult", "preteen", "ghost"];
const CUSTOM_NARRATOR_MAX_CHARS = 500;
const DEFAULT_STOP_IMAGE = "/images/salem/placeholder.png";
const LANDING_THEME_STORAGE_KEY = "wandrful-theme";
const CITY_META: Record<CityOption, { label: string; center: { lat: number; lng: number } }> = {
  salem: { label: "Salem", center: { lat: 42.5195, lng: -70.8967 } },
  boston: { label: "Boston", center: { lat: 42.3601, lng: -71.0589 } },
  concord: { label: "Concord", center: { lat: 42.4604, lng: -71.3489 } },
  nyc: { label: "New York City", center: { lat: 40.7527, lng: -73.9772 } },
};
const FEATURED_PRESET_SECTIONS = [
  {
    title: "Historical Mixes",
    routeIds: [
      "boston-revolutionary-secrets",
      "boston-old-taverns",
      "nyc-architecture-walk",
      "salem-after-dark",
    ] as const satisfies readonly RouteDef["id"][],
  },
  {
    title: "NYC Family Friendly Mixes",
    routeIds: [
      "nyc-city-animals-adventure",
      "nyc-superhero-city",
      "nyc-weird-wacky-history",
    ] as const satisfies readonly RouteDef["id"][],
  },
] as const;
const DEFAULT_NEARBY_STORY_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.NEXT_PUBLIC_ENABLE_NEARBY_STORY || "").trim().toLowerCase()
);
const INSTAGRAM_IMPORT_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.NEXT_PUBLIC_ENABLE_INSTAGRAM_IMPORT || "").trim().toLowerCase()
);

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function isLandingTheme(value: string | null): value is LandingTheme {
  return value === "dark" || value === "light";
}

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;

  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);

  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * c;
}

function formatDistance(meters: number) {
  if (!isFinite(meters)) return "";
  const miles = meters / 1609.344;
  if (miles < 0.2) return `${Math.round(meters)} m`;
  return `${miles.toFixed(miles < 1 ? 2 : 1)} mi`;
}

function estimateWalkMinutes(meters: number) {
  // ~1.35 m/s ≈ 3.0 mph
  const seconds = meters / 1.35;
  return Math.max(1, Math.round(seconds / 60));
}

function toSafeStopImage(value: string | null | undefined) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return DEFAULT_STOP_IMAGE;
  if (normalized.startsWith("/")) return normalized;
  if (normalized.startsWith("https://") || normalized.startsWith("http://")) return normalized;
  return DEFAULT_STOP_IMAGE;
}

function getRouteMiles(stops: RouteDef["stops"]) {
  if (stops.length < 2) return 0;
  let totalMeters = 0;
  for (let i = 1; i < stops.length; i += 1) {
    totalMeters += haversineMeters(stops[i - 1].lat, stops[i - 1].lng, stops[i].lat, stops[i].lng);
  }
  return totalMeters / 1609.344;
}

function formatRouteMiles(miles: number) {
  return `${miles.toFixed(miles < 1 ? 2 : 1)} miles`;
}

function formatStopCount(count: number) {
  return `${count} stop${count === 1 ? "" : "s"}`;
}

function formatUsdCents(amountUsdCents: number) {
  return `$${(amountUsdCents / 100).toFixed(2)}`;
}

function getRoutePricingLabel(pricing: RoutePricing | undefined) {
  const displayLabel = typeof pricing?.displayLabel === "string" ? pricing.displayLabel.trim() : "";
  if (displayLabel) return displayLabel;
  if (pricing?.status === "free") return "FREE";
  if (pricing?.status === "paid" && typeof pricing.amountUsdCents === "number") {
    return formatUsdCents(pricing.amountUsdCents);
  }
  return "TBD";
}

function getPresetRouteNarratorLabel(route: Pick<RouteDef, "storyBy" | "defaultPersona">) {
  return getRouteNarratorLabel(route, route.defaultPersona);
}

function getPresetRouteStopCount(route: Pick<RouteDef, "city" | "stops">) {
  if (route.stops.some((stop) => Boolean(stop.isOverview) || isPresetOverviewStopId(stop.id))) {
    return route.stops.length;
  }
  return route.city ? route.stops.length + 1 : route.stops.length;
}

function getPresetRouteIcon() {
  return "/icons/stars.svg";
}

function hashString(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function getLandingTitleFontClass(routeId: string) {
  if (routeId === "boston-revolutionary-secrets") return landingRevolutionaryFont.className;
  if (routeId === "boston-old-taverns") return landingTavernsFont.className;
  if (routeId === "nyc-architecture-walk") return landingArchitectureFont.className;
  if (routeId === "salem-after-dark") return landingSalemFont.className;
  if (routeId === "nyc-city-animals-adventure") return landingAnimalsFont.className;
  if (routeId === "nyc-superhero-city") return landingSuperheroFont.className;
  if (routeId === "nyc-weird-wacky-history") return landingWeirdHistoryFont.className;
  return "";
}

function getLandingTitleStyleClass(routeId: string) {
  if (routeId === "boston-revolutionary-secrets") return styles.landingFeaturedCardTitleRevolutionary;
  if (routeId === "boston-old-taverns") return styles.landingFeaturedCardTitleTaverns;
  if (routeId === "nyc-architecture-walk") return styles.landingFeaturedCardTitleArchitecture;
  if (routeId === "salem-after-dark") return styles.landingFeaturedCardTitleSalem;
  if (routeId === "nyc-city-animals-adventure") return styles.landingFeaturedCardTitleAnimals;
  if (routeId === "nyc-superhero-city") return styles.landingFeaturedCardTitleSuperhero;
  if (routeId === "nyc-weird-wacky-history") return styles.landingFeaturedCardTitleWeirdHistory;
  return "";
}

function getLandingRouteImage(route: RouteDef) {
  const stopsWithPlaceIds = route.stops.filter((stop) => (stop.googlePlaceId || "").trim().length > 0);
  if (stopsWithPlaceIds.length > 0) {
    const index = hashString(route.id) % stopsWithPlaceIds.length;
    const placeId = (stopsWithPlaceIds[index]?.googlePlaceId || "").trim();
    if (placeId) {
      return `/api/google-image?kind=place-id-photo&placeId=${encodeURIComponent(placeId)}&maxWidthPx=1400`;
    }
  }
  if (route.city) {
    return getPresetCityMeta(route.city).fallbackImage;
  }
  return DEFAULT_STOP_IMAGE;
}

function toKnownCityOption(value: string | null | undefined): RouteDef["city"] | undefined {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized === "salem" || normalized === "boston" || normalized === "concord" || normalized === "nyc") return normalized;
  return undefined;
}

function formatAudioTime(seconds: number) {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function getStopCoordKey(stop: { lat: number; lng: number }) {
  return `${stop.lat.toFixed(6)},${stop.lng.toFixed(6)}`;
}

function stopMatches(a: CustomMixStop, b: CustomMixStop) {
  const aId = (a.id || "").trim();
  const bId = (b.id || "").trim();
  if (aId && bId) return aId === bId;
  return getStopCoordKey(a) === getStopCoordKey(b);
}

function mergeUniqueStops(primary: CustomMixStop[], secondary: CustomMixStop[]) {
  const merged: CustomMixStop[] = [];
  for (const stop of primary) {
    if (merged.some((m) => stopMatches(m, stop))) continue;
    merged.push(stop);
  }
  for (const stop of secondary) {
    if (merged.some((m) => stopMatches(m, stop))) continue;
    merged.push(stop);
  }
  return merged;
}

function moveItem<T>(items: T[], from: number, to: number) {
  if (!Array.isArray(items) || items.length === 0) return items;
  if (from === to) return items;
  if (from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (typeof moved === "undefined") return items;
  next.splice(to, 0, moved);
  return next;
}

function mapNearbyStopsToCustomStops(stops: CustomMixStop[]) {
  return stops.map((stop) => ({
    id: stop.id,
    title: stop.title,
    lat: stop.lat,
    lng: stop.lng,
    image: stop.image || DEFAULT_STOP_IMAGE,
    googlePlaceId: stop.googlePlaceId,
  }));
}

function prioritizeOverviewById<T extends { id: string }>(stops: T[]) {
  const overview = stops.filter((stop) => isPresetOverviewStopId(stop.id));
  if (overview.length === 0) return stops;
  const rest = stops.filter((stop) => !isPresetOverviewStopId(stop.id));
  return [...overview, ...rest];
}

async function preloadAudioMetadata(url: string, timeoutMs = 4000): Promise<"ready" | "timeout" | "error"> {
  return await new Promise((resolve) => {
    let settled = false;
    const audio = new Audio();
    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("error", onError);
      window.clearTimeout(timeoutId);
    };
    const finish = (result: "ready" | "timeout" | "error") => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onLoaded = () => finish("ready");
    const onError = () => finish("error");
    const timeoutId = window.setTimeout(() => finish("timeout"), timeoutMs);

    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("error", onError);
    audio.src = url;
    void audio.load();
  });
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = (await res.json()) as T;
    if (!res.ok) {
      const errorMessage =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error?: unknown }).error === "string"
          ? ((body as { error: string }).error)
          : `Request failed: ${res.status}`;
      throw new Error(errorMessage);
    }
    return body;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("Timed out while starting generation. Please try again.");
    }
    throw e;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function requestCurrentGeoPosition(timeoutMs = 8000): Promise<{ lat: number; lng: number }> {
  return await new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported on this device."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        reject(new Error("Location permission is required to tell nearby stories."));
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
  });
}

export default function HomeClient() {
  const [distanceToStopM, setDistanceToStopM] = useState<number | null>(null);
const [proximity, setProximity] = useState<"far" | "near" | "arrived">("far");
const audioRef = useRef<HTMLAudioElement | null>(null);
const [isPlaying, setIsPlaying] = useState(false);
const [audioTime, setAudioTime] = useState(0);
const [audioDuration, setAudioDuration] = useState(0);
const [listenCount, setListenCount] = useState(0);
const [selectedRouteId, setSelectedRouteId] = useState<RouteDef["id"] | null>(null);
const [isCreateOwnSelected, setIsCreateOwnSelected] = useState(false);
const [selectedPersona, setSelectedPersona] = useState<Persona | null>(null);
const [customNarratorGuidance, setCustomNarratorGuidance] = useState("");
const [pickDurationPage, setPickDurationPage] = useState<PickDurationPage>("routes");
const [narratorFlowSource, setNarratorFlowSource] = useState<NarratorFlowSource>(null);
const [selectedCity, setSelectedCity] = useState<CityOption>("salem");
const [instantDiscoveryCity, setInstantDiscoveryCity] = useState<string | null>(null);
const [builderSelectedStops, setBuilderSelectedStops] = useState<CustomMixStop[]>([]);
const [buildMixOrderedStops, setBuildMixOrderedStops] = useState<CustomMixStop[]>([]);
const [searchInput, setSearchInput] = useState("");
const [isSearchingPlaces, setIsSearchingPlaces] = useState(false);
const [searchCandidates, setSearchCandidates] = useState<CustomMixStop[]>([]);
const [searchError, setSearchError] = useState<string | null>(null);
  const [isGeneratingMix, setIsGeneratingMix] = useState(false);
  const [pendingPresetRouteAction, setPendingPresetRouteAction] = useState<{
    routeId: string;
    mode: "start" | "regenerate";
  } | null>(null);
const [generationJobId, setGenerationJobId] = useState<string | null>(null);
const [generationJobKind, setGenerationJobKind] = useState<GenerationJobKind | null>(null);
const [generationProgress, setGenerationProgress] = useState(0);
const [generationStatusLabel, setGenerationStatusLabel] = useState(GENERATION_STATUS_LABELS.queued);
const [generationMessage, setGenerationMessage] = useState("Queued");
const [landingTheme, setLandingTheme] = useState<LandingTheme>("dark");
const [hasLoadedLandingTheme, setHasLoadedLandingTheme] = useState(false);
const [customRoute, setCustomRoute] = useState<RouteDef | null>(null);
const [followAlongOrigin, setFollowAlongOrigin] = useState<FollowAlongLocation | null>(null);
const [followAlongDestinationQuery, setFollowAlongDestinationQuery] = useState("");
const [followAlongDestinationResults, setFollowAlongDestinationResults] = useState<
  FollowAlongSearchResponse["results"]
>([]);
const [followAlongDestination, setFollowAlongDestination] = useState<FollowAlongLocation | null>(null);
const [followAlongPreview, setFollowAlongPreview] = useState<FollowAlongPreviewResponse | null>(null);
const [isSearchingFollowAlongDestinations, setIsSearchingFollowAlongDestinations] = useState(false);
const [isLoadingFollowAlongPreview, setIsLoadingFollowAlongPreview] = useState(false);
const [isCreatingFollowAlong, setIsCreatingFollowAlong] = useState(false);
const [followAlongRouteProgressM, setFollowAlongRouteProgressM] = useState<number | null>(null);
const [followAlongOffRoute, setFollowAlongOffRoute] = useState(false);
const [followAlongStatusCopy, setFollowAlongStatusCopy] = useState("Waiting for route preview");
const [isScriptModalOpen, setIsScriptModalOpen] = useState(false);
const [isScriptModalClosing, setIsScriptModalClosing] = useState(false);
const [isGeneratingScriptForModal, setIsGeneratingScriptForModal] = useState(false);
const [isGeneratingAudioForCurrentStop, setIsGeneratingAudioForCurrentStop] = useState(false);
const [isGeneratingNearbyStory, setIsGeneratingNearbyStory] = useState(false);
const [isResolvingNearbyGeo, setIsResolvingNearbyGeo] = useState(false);
const [returnToWalkOnClose, setReturnToWalkOnClose] = useState(false);
const [isEditingStopsFromWalk, setIsEditingStopsFromWalk] = useState(false);
const [activeStopIndex, setActiveStopIndex] = useState<number | null>(null);
const [pendingAutoplayStopId, setPendingAutoplayStopId] = useState<string | null>(null);
const previousStepRef = useRef<FlowStep>("landing");
const scriptModalCloseTimeoutRef = useRef<number | null>(null);
const followAlongSessionRef = useRef(0);
const followAlongLastPositionRef = useRef<{
  lat: number;
  lng: number;
  timestamp: number;
} | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();

  const [err, setErr] = useState<string | null>(null);
  const [jam, setJam] = useState<JamRow | null>(null);
  const countedJamOpenRef = useRef<Set<string>>(new Set());

  const [step, setStep] = useState<FlowStep>("landing");
  const toggleLandingTheme = useCallback(() => {
    setLandingTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"));
  }, []);

  // For MVP: Salem-only. This just controls whether we use geolocation-derived distances.
  const [geoAllowed, setGeoAllowed] = useState<boolean | null>(null);
  const [myPos, setMyPos] = useState<{ lat: number; lng: number } | null>(null);
  const [isNearbyStoryEnabled, setIsNearbyStoryEnabled] = useState(DEFAULT_NEARBY_STORY_ENABLED);

  const jamIdFromUrl = searchParams.get("jam");
  const debugStepFromUrl = searchParams.get("debugStep");
  const nextLandingTheme = landingTheme === "dark" ? "light" : "dark";

  // Derive route + stop from jam
  const route: RouteDef | null = useMemo(
    () => customRoute ?? getRouteById(jam?.route_id ?? null),
    [customRoute, jam?.route_id]
  );
  const persona: Persona = (jam?.persona ?? "adult") as Persona;
  const isPresetWalkRoute = Boolean(jam?.route_id && !jam.route_id.startsWith("custom:"));
  const currentStopIndex = useMemo(() => {
    if (!route || activeStopIndex === null) return null;
    return clamp(activeStopIndex, 0, route.stops.length - 1);
  }, [activeStopIndex, route]);

  const currentStop = route && currentStopIndex !== null ? route.stops[currentStopIndex] : null;
  const currentStopScript = useMemo(() => {
    if (!currentStop) return "";
    return currentStop?.text?.[persona] || "";
  }, [currentStop, persona]);
  const currentStopAudio = useMemo(() => {
    if (!currentStop) return "";
    return (currentStop.audio[persona] || "").trim();
  }, [currentStop, persona]);
  const hasCurrentAudio = currentStopAudio.length > 0;
  const customRouteCity = instantDiscoveryCity ?? route?.city ?? "nearby";
  const routeMilesLabel = useMemo(() => {
    if (!route) return "";
    if (typeof route.routeDistanceMeters === "number" && route.routeDistanceMeters > 0) {
      return formatDistance(route.routeDistanceMeters);
    }
    return formatRouteMiles(getRouteMiles(route.stops));
  }, [route]);
  const displayListenerCount = Math.max(listenCount, 1);
  const featuredPresetSections = useMemo(
    () =>
      FEATURED_PRESET_SECTIONS.map((section) => ({
        title: section.title,
        routes: section.routeIds
          .map((routeId) => getRouteById(routeId))
          .filter((route): route is RouteDef => Boolean(route)),
      })).filter((section) => section.routes.length > 0),
    []
  );
  const routesForSelectedCity = useMemo(() => getPresetRoutesByCity(selectedCity), [selectedCity]);
  const selectedRoute = useMemo(
    () => (selectedRouteId ? getRouteById(selectedRouteId) : null),
    [selectedRouteId]
  );
  const selectedCityLabel = useMemo(
    () => CITY_META[selectedCity].label,
    [selectedCity]
  );
  const selectedCityCenter = useMemo(
    () => CITY_META[selectedCity].center,
    [selectedCity]
  );
  const availableStopsForCity = useMemo<CustomMixStop[]>(() => {
    const overview = buildPresetOverviewStop(selectedCity);
    const byId = new Map<string, CustomMixStop>();
    byId.set(overview.id, {
      id: overview.id,
      title: overview.title,
      lat: overview.lat,
      lng: overview.lng,
      image: overview.image,
    });
    for (const r of routesForSelectedCity) {
      for (const s of r.stops) {
        if (byId.has(s.id)) continue;
        byId.set(s.id, {
          id: s.id,
          title: s.title,
          lat: s.lat,
          lng: s.lng,
          image: toSafeStopImage(s.images[0]),
        });
      }
    }
    return Array.from(byId.values());
  }, [routesForSelectedCity, selectedCity]);
  const buildMixDisplayStops = useMemo(() => {
    const orderedSelected = buildMixOrderedStops.filter((ordered) =>
      builderSelectedStops.some((selected) => stopMatches(selected, ordered))
    );
    const missingSelected = builderSelectedStops.filter((selected) =>
      !orderedSelected.some((ordered) => stopMatches(ordered, selected))
    );
    return [...orderedSelected, ...missingSelected];
  }, [buildMixOrderedStops, builderSelectedStops]);
  const activePersonaDisplayName = getRouteNarratorLabel(route, persona);
  const isInstagramAttributedCustomRoute =
    !isPresetWalkRoute && route?.storyBySource === "instagram" && Boolean(route?.storyBy?.trim());
  const instagramStoryByLabel = isInstagramAttributedCustomRoute ? route?.storyBy?.trim() || null : null;
  const instagramStoryByUrl = isInstagramAttributedCustomRoute ? route?.storyByUrl?.trim() || null : null;
  const instagramStoryByAvatarUrl = isInstagramAttributedCustomRoute ? route?.storyByAvatarUrl?.trim() || null : null;
  const activePresetWalkRouteId =
    step === "walk" && isPresetWalkRoute && jam?.route_id ? (jam.route_id as RouteDef["id"]) : null;
  const isActivePresetWalkRegenerating =
    activePresetWalkRouteId !== null &&
    pendingPresetRouteAction?.routeId === activePresetWalkRouteId &&
    pendingPresetRouteAction.mode === "regenerate";
  const isAiPersona = (personaKey: Persona) => personaCatalog[personaKey].displayName.startsWith("AI");
  const usesNarratorIcon = (personaKey: Persona) => personaKey === "custom" || isAiPersona(personaKey);
  const customNarratorEnabled =
    narratorFlowSource === "followAlong" ||
    narratorFlowSource === "buildMix" ||
    (narratorFlowSource === "walkEdit" && !isPresetWalkRoute);
  const trimmedCustomNarratorGuidance = customNarratorGuidance.trim();
  const narratorSubmitDisabled =
    !selectedPersona ||
    isGeneratingMix ||
    isCreatingFollowAlong ||
    (selectedPersona === "custom" && trimmedCustomNarratorGuidance.length === 0);
  const narratorSubmitLabel = returnToWalkOnClose
    ? "Update Narrator"
    : narratorFlowSource === "followAlong"
      ? (isCreatingFollowAlong ? "Building route..." : "Start Follow Along")
      : "Create Tour";
  const customNarratorHelpText =
    narratorFlowSource === "followAlong"
      ? "Tell EchoJam who this drive is for and how the narration should sound."
      : "Tell EchoJam who this tour is for and how the narration should sound.";
  const customNarratorPlaceholder =
    narratorFlowSource === "followAlong"
      ? "Road-trip voice for two adults who love architecture, local lore, and concise stories."
      : "This tour is for my niece Kate who is 8 years old. She loves animals, so make it kid friendly, fun, and mention animals whenever relevant.";
  const maxStopsForSelection = useMemo(
    () => getMaxStops(),
    []
  );
  const selectionValidation = useMemo(
    () => validateMixSelection(30, "walk", builderSelectedStops.length),
    [builderSelectedStops.length]
  );
  const selectedStopsDistanceMiles = useMemo(() => {
    if (builderSelectedStops.length < 2) return 0;
    let totalMeters = 0;
    for (let i = 1; i < builderSelectedStops.length; i += 1) {
      const prev = builderSelectedStops[i - 1];
      const next = builderSelectedStops[i];
      totalMeters += haversineMeters(prev.lat, prev.lng, next.lat, next.lng);
    }
    return totalMeters / 1609.344;
  }, [builderSelectedStops]);
  const hasOffRouteAddsInEdit = useMemo(() => {
    if (!isEditingStopsFromWalk || !route) return false;
    const routeStopIds = new Set(route.stops.map((s) => s.id));
    return builderSelectedStops.some((s) => !routeStopIds.has(s.id));
  }, [isEditingStopsFromWalk, route, builderSelectedStops]);
  const availableSearchCandidates = useMemo(
    () => searchCandidates.filter((candidate) => !builderSelectedStops.some((selected) => stopMatches(selected, candidate))),
    [searchCandidates, builderSelectedStops]
  );
  const generatingBackgroundImage = useMemo(() => {
    if (generationJobKind === "custom") {
      const sourceStops = buildMixOrderedStops.length > 0 ? buildMixOrderedStops : builderSelectedStops;
      const stopWithImage = sourceStops.find((stop) => (stop.image || "").trim().length > 0);
      if (stopWithImage) return toSafeStopImage(stopWithImage.image);
    }

    const presetRoute = selectedRouteId ? getRouteById(selectedRouteId) : selectedRoute;
    if (presetRoute) return getLandingRouteImage(presetRoute);

    const routeStopWithImage = route?.stops.find((stop) => (stop.images[0] || "").trim().length > 0);
    if (routeStopWithImage) return toSafeStopImage(routeStopWithImage.images[0]);

    return DEFAULT_STOP_IMAGE;
  }, [buildMixOrderedStops, builderSelectedStops, generationJobKind, route, selectedRoute, selectedRouteId]);
  const narratorPreviewStops = useMemo(() => {
    if (narratorFlowSource === "buildMix") {
      return buildMixDisplayStops;
    }
    if (narratorFlowSource === "followAlong" && followAlongDestination) {
      return [
        {
          id: "follow-preview-destination",
          title: followAlongDestination.label,
          lat: followAlongDestination.lat,
          lng: followAlongDestination.lng,
          images: [DEFAULT_STOP_IMAGE],
          stopKind: "arrival" as const,
        },
      ];
    }
    return [];
  }, [buildMixDisplayStops, followAlongDestination, narratorFlowSource]);
  const narratorPreviewCityCenter =
    narratorFlowSource === "followAlong"
      ? (followAlongOrigin ?? selectedCityCenter)
      : selectedCityCenter;
  const narratorPreviewShowRoutePath =
    narratorFlowSource === "followAlong" && Boolean(followAlongPreview);
  const narratorPreviewRouteCoords =
    narratorFlowSource === "followAlong"
      ? (followAlongPreview?.routeCoords ?? null)
      : null;
  const narratorPreviewRouteTravelMode =
    narratorFlowSource === "followAlong" ? "drive" : null;
  const narratorPreviewEndpoints =
    narratorFlowSource === "followAlong"
      ? {
          origin: followAlongPreview?.origin ?? followAlongOrigin,
          destination: followAlongPreview?.destination ?? followAlongDestination,
        }
      : null;

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const storedTheme = window.localStorage.getItem(LANDING_THEME_STORAGE_KEY);
      if (isLandingTheme(storedTheme)) {
        setLandingTheme(storedTheme);
      }
    } catch {
      // Ignore localStorage access failures and keep the default theme.
    } finally {
      setHasLoadedLandingTheme(true);
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedLandingTheme || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(LANDING_THEME_STORAGE_KEY, landingTheme);
    } catch {
      // Ignore localStorage access failures; the toggle still works for this session.
    }
  }, [hasLoadedLandingTheme, landingTheme]);

  useEffect(() => {
    let cancelled = false;

    void fetch("/api/feature-flags", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Feature flag request failed");
        }
        return await response.json() as { nearbyStoryEnabled?: boolean };
      })
      .then((payload) => {
        if (cancelled || typeof payload.nearbyStoryEnabled !== "boolean") return;
        setIsNearbyStoryEnabled(payload.nearbyStoryEnabled);
      })
      .catch(() => {
        // Keep the build-time fallback if the runtime flag lookup fails.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // ---------- Supabase: load jam ----------
  async function loadJamById(id: string) {
    setErr(null);
    const { data, error } = await supabase
      .from("jams")
      .select("id,host_name,route_id,persona,current_stop,completed_at,is_playing,position_ms")
      .eq("id", id)
      .single();

    if (error) {
      setErr(error.message);
      setJam(null);
      setStep("landing");
      return;
    }

    setJam(data as JamRow);

    const [presetJobResult, customJobResult] = await Promise.all([
      supabase
        .from("preset_generation_jobs")
        .select("id,status")
        .eq("jam_id", id)
        .in("status", ["queued", "generating_script", "generating_audio"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("mix_generation_jobs")
        .select("id,status")
        .eq("jam_id", id)
        .in("status", ["queued", "generating_script", "generating_audio"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const presetActive = (presetJobResult.data ?? null) as ActiveGenerationJobRow | null;
    const customActive = (customJobResult.data ?? null) as ActiveGenerationJobRow | null;
    const activeJob = presetActive ?? customActive;
    if (activeJob?.id) {
      setGenerationJobId(activeJob.id);
      setGenerationJobKind(presetActive ? "preset" : "custom");
      setGenerationProgress(0);
      setGenerationStatusLabel(getGenerationStatusLabel(activeJob.status));
      setGenerationMessage("Queued");
      setStep("generating");
      return;
    }

    // Decide which screen we’re on
    if (!data.route_id) {
      setPickDurationPage("routes");
      setNarratorFlowSource(null);
      setStep("landing");
    }
    else if (data.completed_at) setStep("end");
    else setStep("walk");
  }

  // ---------- Supabase: create jam ----------
  async function createJam(routeId?: string, personaValue: Persona = "adult", opts?: { skipStep?: boolean }) {
    setErr(null);

    // If routeId provided we can jump straight to walk; otherwise we’ll go to pickDuration.
    const insertRow: Partial<JamRow> & {
      host_name?: string;
      route_id?: string | null;
      persona?: Persona;
      current_stop?: number;
      is_playing?: boolean;
      position_ms?: number;
    } = {
      host_name: "Rob",
      route_id: routeId ?? null,
      persona: personaValue,
      current_stop: 0,

      // legacy
      is_playing: false,
      position_ms: 0,
    };

    const { data, error } = await supabase
      .from("jams")
      .insert(insertRow)
      .select("id,host_name,route_id,persona,current_stop,completed_at,is_playing,position_ms")
      .single();

    if (error) {
      setErr(error.message);
      return null;
    }

    setJam(data as JamRow);

    if (!opts?.skipStep) {
      // Put it in URL like your existing flow
      router.replace(`/?jam=${data.id}`);
      if (!routeId) {
        setStep("landing");
      }
      else setStep("walk");
    }
    return data.id as string;
  }

  // ---------- Supabase: update jam ----------
  async function updateJam(patch: Partial<JamRow>): Promise<boolean> {
    if (!jam) return false;
    setErr(null);

    const { data, error } = await supabase
      .from("jams")
      .update(patch)
      .eq("id", jam.id)
      .select("id,host_name,route_id,persona,current_stop,completed_at,is_playing,position_ms")
      .single();

    if (error) {
      setErr(error.message);
      return false;
    }
    setJam(data as JamRow);
    return true;
  }

  function handleNarratorSelect(nextPersona: Persona) {
    setErr(null);
    setSelectedPersona(nextPersona);
    if (nextPersona !== "custom") {
      setCustomNarratorGuidance((current) => current.trim());
    }
    if (customNarratorEnabled) {
      return;
    }
    void submitNarratorSelection(nextPersona);
  }

  async function submitNarratorSelection(personaOverride?: Persona) {
    const personaForSubmit = personaOverride ?? selectedPersona;
    if (!personaForSubmit) return;
    if (personaForSubmit === "custom" && trimmedCustomNarratorGuidance.length === 0) {
      setErr("Add narrator guidance to create a custom narrator.");
      return;
    }

    if (narratorFlowSource === "buildMix") {
      await startCustomMixGeneration(builderSelectedStops, personaForSubmit, {
        narratorGuidance: personaForSubmit === "custom" ? trimmedCustomNarratorGuidance : null,
      });
      return;
    }

    if (narratorFlowSource === "followAlong") {
      await startFollowAlongExperience(personaForSubmit);
      return;
    }

    if (returnToWalkOnClose && jam?.route_id && route) {
      const currentStops = route.stops.map((stop) => ({
        id: stop.id,
        title: stop.title,
        lat: stop.lat,
        lng: stop.lng,
        image: toSafeStopImage(stop.images[0]),
      }));
      setReturnToWalkOnClose(false);
      await startCustomMixGeneration(currentStops, personaForSubmit, {
        errorStep: "pickDuration",
        cityOverride: customRouteCity,
        routeTitle: route.title,
        narratorGuidance: personaForSubmit === "custom" ? trimmedCustomNarratorGuidance : null,
      });
      return;
    }

    setNarratorFlowSource(null);
    setStep("landing");
  }

  async function copyShareLink() {
    if (!jam) return;
    await navigator.clipboard?.writeText(`${window.location.origin}/j/${jam.id}`);
  }

  function goHome() {
    if (scriptModalCloseTimeoutRef.current) {
      window.clearTimeout(scriptModalCloseTimeoutRef.current);
      scriptModalCloseTimeoutRef.current = null;
    }
    router.replace("/");
    setJam(null);
    setCustomRoute(null);
    setGenerationJobId(null);
    setGenerationJobKind(null);
    setIsScriptModalOpen(false);
    setIsScriptModalClosing(false);
    setReturnToWalkOnClose(false);
    setNarratorFlowSource(null);
    setSelectedRouteId(null);
    setIsCreateOwnSelected(false);
    setSelectedPersona(null);
    setCustomNarratorGuidance("");
    setInstantDiscoveryCity(null);
    followAlongSessionRef.current += 1;
    setFollowAlongOrigin(null);
    setFollowAlongDestinationQuery("");
    setFollowAlongDestinationResults([]);
    setFollowAlongDestination(null);
    setFollowAlongPreview(null);
    setFollowAlongOffRoute(false);
    setFollowAlongRouteProgressM(null);
    setFollowAlongStatusCopy("Waiting for route preview");
    setPickDurationPage("routes");
    setStep("landing");
  }

  function openPresetCity(city: CityOption) {
    setErr(null);
    setSelectedCity(city);
    setSelectedRouteId(null);
    setSelectedPersona(null);
    setCustomNarratorGuidance("");
    setNarratorFlowSource(null);
    setPickDurationPage("routes");
    setStep("pickDuration");
  }

  function toFollowAlongOrigin(
    coords: { lat: number; lng: number },
    subtitle?: string | null
  ): FollowAlongLocation {
    return {
      label: "Current location",
      subtitle: subtitle?.trim() ? subtitle.trim() : null,
      lat: coords.lat,
      lng: coords.lng,
    };
  }

  async function resolveFollowAlongOrigin(
    coords: { lat: number; lng: number },
    sessionId: number
  ) {
    if (sessionId !== followAlongSessionRef.current) return;

    setFollowAlongOrigin(
      toFollowAlongOrigin(coords, FOLLOW_ALONG_ORIGIN_PENDING_SUBTITLE)
    );

    try {
      const body = await fetchJsonWithTimeout<FollowAlongOriginResponse>(
        "/api/follow-along/origin",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(coords),
        },
        POLL_REQUEST_TIMEOUT_MS
      );

      if (sessionId !== followAlongSessionRef.current) return;

      setFollowAlongOrigin({
        ...body.origin,
        subtitle:
          typeof body.origin.subtitle === "string" && body.origin.subtitle.trim().length > 0
            ? body.origin.subtitle.trim()
            : FOLLOW_ALONG_ORIGIN_FALLBACK_SUBTITLE,
      });
    } catch {
      if (sessionId !== followAlongSessionRef.current) return;
      setFollowAlongOrigin(
        toFollowAlongOrigin(coords, FOLLOW_ALONG_ORIGIN_FALLBACK_SUBTITLE)
      );
    }
  }

  async function openFollowAlongSetup() {
    const sessionId = followAlongSessionRef.current + 1;
    followAlongSessionRef.current = sessionId;
    setErr(null);
    setSelectedRouteId(null);
    setSelectedPersona((current) => current ?? "adult");
    setCustomNarratorGuidance((current) => current.trim());
    setNarratorFlowSource(null);
    setFollowAlongDestinationQuery("");
    setFollowAlongDestinationResults([]);
    setFollowAlongDestination(null);
    setFollowAlongPreview(null);
    setFollowAlongStatusCopy("Enter a destination to preview the drive.");
    setStep("followAlongSetup");

    if (myPos) {
      void resolveFollowAlongOrigin(myPos, sessionId);
      return;
    }

    try {
      const coords = await requestCurrentGeoPosition();
      if (sessionId !== followAlongSessionRef.current) return;
      setMyPos(coords);
      setGeoAllowed(true);
      void resolveFollowAlongOrigin(coords, sessionId);
    } catch (e) {
      if (sessionId !== followAlongSessionRef.current) return;
      setGeoAllowed(false);
      setFollowAlongOrigin(null);
      setErr(e instanceof Error ? e.message : "Location permission is required.");
    }
  }

  async function searchFollowAlongDestinations() {
    const query = followAlongDestinationQuery.trim();
    if (query.length < 2) {
      setErr("Enter at least 2 characters to search.");
      return;
    }
    setErr(null);
    setIsSearchingFollowAlongDestinations(true);
    try {
      const res = await fetch("/api/follow-along/search-destinations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const body = (await res.json()) as
        | FollowAlongSearchResponse
        | { error?: string };
      if (!res.ok || !("results" in body)) {
        throw new Error(("error" in body && body.error) || "Destination search failed.");
      }
      setFollowAlongDestinationResults(body.results);
      if (body.results.length === 0) {
        setErr("No destinations found for that search.");
      }
    } catch (e) {
      setFollowAlongDestinationResults([]);
      setErr(e instanceof Error ? e.message : "Destination search failed.");
    } finally {
      setIsSearchingFollowAlongDestinations(false);
    }
  }

  async function previewFollowAlongRoute(destinationOverride?: FollowAlongLocation) {
    const origin = followAlongOrigin;
    const destination = destinationOverride ?? followAlongDestination;
    if (!origin || !destination) {
      setErr("Choose a destination to preview the route.");
      return;
    }
    setErr(null);
    setIsLoadingFollowAlongPreview(true);
    try {
      const preview = await fetchJsonWithTimeout<FollowAlongPreviewResponse>(
        "/api/follow-along/preview",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ origin, destination }),
        },
        START_JOB_TIMEOUT_MS
      );
      setFollowAlongOrigin(preview.origin);
      setFollowAlongDestination(preview.destination);
      setFollowAlongPreview(preview);
      setFollowAlongStatusCopy("Route preview ready. Choose a storyteller and start driving.");
    } catch (e) {
      setFollowAlongPreview(null);
      setErr(e instanceof Error ? e.message : "Route preview failed.");
    } finally {
      setIsLoadingFollowAlongPreview(false);
    }
  }

  async function startFollowAlongExperience(personaOverride?: Persona) {
    const personaForSubmit = personaOverride ?? selectedPersona;
    if (!followAlongOrigin || !followAlongDestination || !personaForSubmit) {
      setErr("Choose a destination and storyteller first.");
      return;
    }
    if (personaForSubmit === "custom" && trimmedCustomNarratorGuidance.length === 0) {
      setErr("Add narrator guidance to create a custom narrator.");
      return;
    }

    setErr(null);
    setIsCreatingFollowAlong(true);
    setGenerationProgress(0);
    setGenerationStatusLabel(GENERATION_STATUS_LABELS.queued);
    setGenerationMessage("Building your route stories...");
    setStep("generating");

    try {
      const body = await fetchJsonWithTimeout<{
        jamId?: string;
        routeId?: string;
        routeRef?: string;
        jobId?: string;
      }>(
        "/api/follow-along/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jamId: jam?.id ?? null,
            origin: followAlongOrigin,
            destination: followAlongDestination,
            persona: personaForSubmit,
            narratorGuidance:
              personaForSubmit === "custom" ? trimmedCustomNarratorGuidance : null,
          }),
        },
        START_JOB_TIMEOUT_MS
      );
      if (!body.jamId || !body.jobId) {
        throw new Error("Missing follow along generation metadata.");
      }
      setGenerationJobId(body.jobId);
      setGenerationJobKind("custom");
      router.replace(`/?jam=${body.jamId}`);
    } catch (e) {
      setPickDurationPage("narrator");
      setStep("pickDuration");
      setGenerationJobId(null);
      setGenerationJobKind(null);
      setErr(e instanceof Error ? e.message : "Failed to create Follow Along.");
    } finally {
      setIsCreatingFollowAlong(false);
    }
  }

  function closeRoutePicker() {
    if (returnToWalkOnClose && jam?.route_id) {
      setStep("walk");
      setReturnToWalkOnClose(false);
      setNarratorFlowSource(null);
      return;
    }
    setNarratorFlowSource(null);
    goHome();
  }

  function closeNarratorPicker() {
    if (returnToWalkOnClose && jam?.route_id) {
      setStep("walk");
      setReturnToWalkOnClose(false);
      setNarratorFlowSource(null);
      return;
    }
    if (narratorFlowSource === "buildMix") {
      setStep("buildMix");
      return;
    }
    if (narratorFlowSource === "followAlong") {
      setStep("followAlongSetup");
      return;
    }
    setNarratorFlowSource(null);
    setStep("landing");
  }

  function getCustomRouteId(routeRef: string | null | undefined) {
    if (!routeRef?.startsWith("custom:")) return null;
    return routeRef.slice("custom:".length) || null;
  }

  function getGenerationStatusLabel(status: MixJobResponse["status"]) {
    return GENERATION_STATUS_LABELS[status];
  }

  const loadResolvedRoute = useCallback(async (routeRef: string) => {
    const customRouteId = getCustomRouteId(routeRef);
    const isCustom = Boolean(customRouteId);
    const presetRoute = getRouteById(routeRef);
    if (!isCustom && !presetRoute) {
      setCustomRoute(null);
      return null;
    }
    const endpoint = isCustom
      ? `/api/custom-routes/${customRouteId}`
      : `/api/preset-routes/${routeRef}`;
    const res = await fetch(endpoint);
    if (!res.ok) {
      let detail: string | null = null;
      try {
        const errorPayload = (await res.json()) as { error?: string };
        detail = typeof errorPayload?.error === "string" ? errorPayload.error.trim() : null;
      } catch {
        detail = null;
      }
      throw new Error(detail || `Failed to load ${isCustom ? "custom" : "preset"} route`);
    }
    const payload = (await res.json()) as CustomRouteResponse;
    const resolvedCity = isCustom
      ? (payload.route.city || "").trim().toLowerCase() || instantDiscoveryCity || "nearby"
      : (presetRoute?.city ?? selectedCity);
    const mappedStops: RouteDef["stops"] = payload.stops.map((s, idx) => {
      const stopId = s.stop_id || `custom-${idx}`;
      return {
      id: stopId,
      title: s.title,
      lat: s.lat,
      lng: s.lng,
      isOverview: Boolean(s.is_overview) || isPresetOverviewStopId(stopId),
      stopKind: s.stop_kind || "story",
      distanceAlongRouteMeters:
        typeof s.distance_along_route_meters === "number"
          ? s.distance_along_route_meters
          : null,
      triggerRadiusMeters:
        typeof s.trigger_radius_meters === "number"
          ? s.trigger_radius_meters
          : null,
      images: [toSafeStopImage(s.image_url)],
      audio: {
        adult: s.audio_url_adult || "",
        preteen: s.audio_url_preteen || "",
        ghost: s.audio_url_ghost || "",
        custom: s.audio_url_custom || "",
      },
      text: {
        adult: s.script_adult || "",
        preteen: s.script_preteen || "",
        ghost: s.script_ghost || "",
        custom: s.script_custom || "",
      },
    };
    });
    const nextRoute: RouteDef = {
      id: routeRef,
      title: payload.route.title,
      durationLabel: `${payload.route.length_minutes} mins`,
      durationMinutes: payload.route.length_minutes,
      description: `${payload.route.transport_mode === "drive" ? "Drive" : "Walk"} • ${formatStopCount(mappedStops.length)}`,
      defaultPersona: isCustom ? ((payload.route.narrator_default ?? jam?.persona ?? "adult") as RouteDef["defaultPersona"]) : (presetRoute?.defaultPersona ?? "adult"),
      storyBy: isCustom ? (payload.route.story_by || undefined) : presetRoute?.storyBy,
      storyByUrl: isCustom ? (payload.route.story_by_url ?? null) : (presetRoute?.storyByUrl ?? null),
      storyByAvatarUrl: isCustom
        ? (payload.route.story_by_avatar_url ?? null)
        : (presetRoute?.storyByAvatarUrl ?? null),
      storyBySource: isCustom ? (payload.route.story_by_source ?? null) : (presetRoute?.storyBySource ?? null),
      narratorGuidance: isCustom ? (payload.route.narrator_guidance || "").trim() || null : (presetRoute?.narratorGuidance ?? null),
      pricing: isCustom ? undefined : presetRoute?.pricing,
      city: isCustom ? toKnownCityOption(resolvedCity) : presetRoute?.city,
      transportMode: payload.route.transport_mode,
      experienceKind: isCustom ? (payload.route.experience_kind ?? "mix") : "preset",
      routePathCoords:
        isCustom && Array.isArray(payload.route.route_polyline)
          ? payload.route.route_polyline
          : null,
      origin:
        isCustom &&
        typeof payload.route.origin_lat === "number" &&
        typeof payload.route.origin_lng === "number" &&
        payload.route.origin_label
          ? {
              lat: payload.route.origin_lat,
              lng: payload.route.origin_lng,
              label: payload.route.origin_label,
            }
          : null,
      destination:
        isCustom &&
        typeof payload.route.destination_lat === "number" &&
        typeof payload.route.destination_lng === "number" &&
        payload.route.destination_label
          ? {
              lat: payload.route.destination_lat,
              lng: payload.route.destination_lng,
              label: payload.route.destination_label,
            }
          : null,
      routeDistanceMeters:
        typeof payload.route.route_distance_meters === "number"
          ? payload.route.route_distance_meters
          : null,
      routeDurationSeconds:
        typeof payload.route.route_duration_seconds === "number"
          ? payload.route.route_duration_seconds
          : null,
      stops: prioritizeOverviewById(mappedStops),
    };
    if (isCustom) {
      setInstantDiscoveryCity(resolvedCity);
      setCustomNarratorGuidance((payload.route.narrator_guidance || "").trim());
    } else {
      setCustomNarratorGuidance("");
    }
    setCustomRoute(nextRoute);
    return nextRoute;
  }, [selectedCity, jam?.persona, instantDiscoveryCity]);

  // ---------- "Start stop” handler ----------
async function startStopNarration() {
  // attempt to play (will work because button click is a user gesture)
  const el = audioRef.current;
  if (!el || !hasCurrentAudio) return;
  try {
    await el.play();
  } catch {
    // autoplay might still be blocked in some cases; user can press play manually
  }
}

  async function handleNearbyStory() {
    if (!isNearbyStoryEnabled || isGeneratingNearbyStory || isResolvingNearbyGeo) return;
    const previousStep = step;

    try {
      setErr(null);
      setIsGeneratingNearbyStory(true);
      setSelectedPersona("adult");
      setGenerationJobId(null);
      setGenerationJobKind(null);
      setGenerationProgress(0);
      setGenerationStatusLabel(GENERATION_STATUS_LABELS.queued);
      setGenerationMessage("Locating your position...");
      setStep("generating");
      let coords = myPos;

      if (!coords) {
        setIsResolvingNearbyGeo(true);
        coords = await requestCurrentGeoPosition();
        setMyPos(coords);
        setGeoAllowed(true);
      }

      setGenerationMessage("Finding a nearby landmark...");

      const nearby = await fetchJsonWithTimeout<NearbyPlacesResponse>(
        "/api/nearby-story/places",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            city: null,
            lat: coords.lat,
            lng: coords.lng,
            minStops: 1,
            maxStops: 1,
          }),
        },
        START_JOB_TIMEOUT_MS
      );

      if (!Array.isArray(nearby.stops) || nearby.stops.length < 1) {
        throw new Error("No nearby places were returned.");
      }

      const mappedStops = mapNearbyStopsToCustomStops(nearby.stops);
      const firstStop = mappedStops[0];
      if (!firstStop) {
        throw new Error("No nearby landmark was returned.");
      }

      setInstantDiscoveryCity((nearby.cityUsed || "").trim() || null);
      const started = await startCustomMixGeneration([firstStop], "adult", {
        source: "instant",
        routeTitle: firstStop.title,
        errorStep: previousStep,
        cityOverride: (nearby.cityUsed || "").trim() || undefined,
      });
      if (!started) {
        setStep(previousStep);
      }
    } catch (e) {
      setGenerationJobId(null);
      setGenerationJobKind(null);
      setGenerationProgress(0);
      setErr(e instanceof Error ? e.message : "Failed to generate nearby story");
      setStep(previousStep);
    } finally {
      setIsResolvingNearbyGeo(false);
      setIsGeneratingNearbyStory(false);
    }
  }

  async function handleFindMoreAroundLocation() {
    if (!route || route.stops.length === 0 || isGeneratingNearbyStory || isResolvingNearbyGeo) return;

    const fallbackStop = currentStop ?? route.stops[0];
    const baseRouteStops: CustomMixStop[] = route.stops.map((stop) => ({
      id: stop.id,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      image: toSafeStopImage(stop.images[0]),
    }));
    let lookupCoords = myPos;

    try {
      setErr(null);
      setIsGeneratingNearbyStory(true);

      if (!lookupCoords) {
        setIsResolvingNearbyGeo(true);
        try {
          lookupCoords = await requestCurrentGeoPosition();
          setMyPos(lookupCoords);
          setGeoAllowed(true);
        } catch {
          setGeoAllowed(false);
        } finally {
          setIsResolvingNearbyGeo(false);
        }
      }

      const anchorCoords = lookupCoords ?? (fallbackStop ? { lat: fallbackStop.lat, lng: fallbackStop.lng } : null);
      if (!anchorCoords) {
        throw new Error("No location is available for nearby search.");
      }

      const nearby = await fetchJsonWithTimeout<NearbyPlacesResponse>(
        "/api/nearby-story/places",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            city: instantDiscoveryCity ?? selectedCity,
            lat: anchorCoords.lat,
            lng: anchorCoords.lng,
            minStops: 1,
            maxStops: maxStopsForSelection,
            minSpreadMeters: 100,
          }),
        },
        START_JOB_TIMEOUT_MS
      );

      if (!Array.isArray(nearby.stops) || nearby.stops.length < 1) {
        throw new Error("No nearby places were returned.");
      }

      const nearbyStops = mapNearbyStopsToCustomStops(nearby.stops);
      const mergedStops = mergeUniqueStops(baseRouteStops, nearbyStops).slice(0, maxStopsForSelection);

      setBuilderSelectedStops(mergedStops);
      setBuildMixOrderedStops(mergedStops);
      setInstantDiscoveryCity((nearby.cityUsed || "").trim() || instantDiscoveryCity);
      setSearchInput("");
      setSearchCandidates([]);
      setSearchError(null);
      setSelectedPersona((jam?.persona ?? "adult") as Persona);
      setNarratorFlowSource(null);
      setIsEditingStopsFromWalk(true);
      setReturnToWalkOnClose(true);
      setStep("buildMix");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to find more nearby places");
    } finally {
      setIsGeneratingNearbyStory(false);
      setIsResolvingNearbyGeo(false);
    }
  }

  async function handleStopSelect(idx: number) {
    if (!route) return;
    const stop = route.stops[idx];
    setActiveStopIndex(idx);
    setPendingAutoplayStopId(stop?.id ?? null);
    await updateJam({ current_stop: idx });
  }

  async function toggleAudio() {
    const el = audioRef.current;
    if (!el || !hasCurrentAudio) return;
    try {
      if (el.paused) await el.play();
      else el.pause();
    } catch {
      // ignore play interruption errors
    }
  }

  async function playPauseFromWalkAction() {
    if (!route || route.stops.length === 0) return;
    if (currentStopIndex === null) {
      await handleStopSelect(0);
      return;
    }
    await toggleAudio();
  }

  function seekAudio(nextTime: number) {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = nextTime;
    setAudioTime(nextTime);
  }

  async function openScriptModal() {
    if (!currentStop || !jam?.route_id) return;
    if (scriptModalCloseTimeoutRef.current) {
      window.clearTimeout(scriptModalCloseTimeoutRef.current);
      scriptModalCloseTimeoutRef.current = null;
    }
    setIsScriptModalClosing(false);
    setIsScriptModalOpen(true);
    const isPresetRoute = !jam.route_id.startsWith("custom:");
    const customRouteId = isPresetRoute ? null : getCustomRouteId(jam.route_id);
    if (!isPresetRoute && !customRouteId) return;

    try {
      setErr(null);
      const needsScript = !currentStopScript;
      const needsAudio = !hasCurrentAudio;

      if (needsScript) {
        setIsGeneratingScriptForModal(true);
        const scriptRes = await fetch(isPresetRoute ? "/api/preset-scripts/generate" : "/api/custom-scripts/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            routeId: isPresetRoute ? jam.route_id : customRouteId,
            stopId: currentStop.id,
            persona,
            city: isPresetRoute ? selectedCity : customRouteCity,
          }),
        });
        const scriptBody = (await scriptRes.json()) as { error?: string };
        if (!scriptRes.ok) throw new Error(scriptBody.error || "Failed to generate script");
      }

      if (needsAudio) {
        setIsGeneratingAudioForCurrentStop(true);
        const audioRes = await fetch(isPresetRoute ? "/api/preset-audio/generate" : "/api/custom-audio/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            routeId: isPresetRoute ? jam.route_id : customRouteId,
            stopId: currentStop.id,
            persona,
            city: isPresetRoute ? selectedCity : customRouteCity,
          }),
        });
        const audioBody = (await audioRes.json()) as { error?: string };
        if (!audioRes.ok) throw new Error(audioBody.error || "Failed to generate audio");
      }

      if (needsScript || needsAudio) {
        await loadResolvedRoute(jam.route_id);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to generate script");
    } finally {
      setIsGeneratingScriptForModal(false);
      setIsGeneratingAudioForCurrentStop(false);
    }
  }

  function closeScriptModal() {
    if (!isScriptModalOpen || isScriptModalClosing) return;
    setIsScriptModalClosing(true);
    if (scriptModalCloseTimeoutRef.current) {
      window.clearTimeout(scriptModalCloseTimeoutRef.current);
    }
    scriptModalCloseTimeoutRef.current = window.setTimeout(() => {
      setIsScriptModalOpen(false);
      setIsScriptModalClosing(false);
      scriptModalCloseTimeoutRef.current = null;
    }, SCRIPT_MODAL_EXIT_MS);
  }

  // ---------- Step transitions ----------

  async function startPresetTour(
    routeId: RouteDef["id"],
    personaSelection: Persona,
    options?: StartPresetTourOptions
  ) {
    const routeCity = (getRouteById(routeId)?.city ?? selectedCity) as CityOption;
    const isForceRegenerate = Boolean(options?.forceRegenerateAll);
    if (
      !isForceRegenerate &&
      returnToWalkOnClose &&
      jam?.id &&
      jam.route_id === routeId &&
      (jam.persona ?? "adult") === personaSelection
    ) {
      setReturnToWalkOnClose(false);
      setStep("walk");
      return;
    }
    setReturnToWalkOnClose(false);
    setErr(null);
    setPendingPresetRouteAction({
      routeId,
      mode: isForceRegenerate ? "regenerate" : "start",
    });
    setStep("generating");
    setGenerationProgress(0);
    setGenerationStatusLabel(GENERATION_STATUS_LABELS.queued);
    setGenerationMessage(isForceRegenerate ? "Regenerating with latest guidance..." : "Queued");
    try {
      let jamId = jam?.id ?? null;
      if (!jamId) {
        jamId = await createJam(routeId, personaSelection, { skipStep: true });
        if (!jamId) {
          setPendingPresetRouteAction(null);
          setStep("landing");
          return;
        }
      } else {
        await updateJam({
          route_id: routeId,
          persona: personaSelection,
          current_stop: 0,
          completed_at: null,
        });
      }

      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), START_JOB_TIMEOUT_MS);
      const res = await fetch("/api/preset-jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jamId,
          routeId,
          persona: personaSelection,
          city: routeCity,
          forceRegenerateAll: isForceRegenerate,
        }),
        signal: controller.signal,
      });
      window.clearTimeout(timeoutId);
      const body = (await res.json()) as { error?: string; jobId?: string; status?: string };
      if (res.status === 429 && body.jobId) {
        setGenerationJobId(body.jobId);
        setGenerationJobKind("preset");
        router.replace(`/?jam=${jamId}`);
        setPendingPresetRouteAction(null);
        return;
      }
      if (!res.ok || !body.jobId) throw new Error(body.error || "Failed to create preset generation job");
      setGenerationJobId(body.jobId);
      setGenerationJobKind("preset");
      router.replace(`/?jam=${jamId}`);
      setPendingPresetRouteAction(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setErr("Timed out while starting generation. Please try again.");
      } else {
        setErr(e instanceof Error ? e.message : "Failed to generate preset tour");
      }
      setGenerationJobKind(null);
      setPendingPresetRouteAction(null);
      setStep("landing");
    }
  }

  function selectPresetRoute(routeId: RouteDef["id"]) {
    if (isCreateOwnSelected) {
      setIsCreateOwnSelected(false);
    }
    const selectedRoute = getRouteById(routeId);
    if (!selectedRoute) {
      setErr("Unknown preset route");
      return null;
    }
    setErr(null);
    setSelectedRouteId(routeId);
    setIsCreateOwnSelected(false);
    setSelectedPersona(selectedRoute.defaultPersona);
    setCustomNarratorGuidance("");
    return selectedRoute;
  }

  function selectCreateOwnMix() {
    setErr(null);
    setSelectedRouteId(null);
    setIsCreateOwnSelected(true);
    setSelectedPersona(null);
    setCustomNarratorGuidance("");
  }

  function goToCreateOwnMixBuilder() {
    selectCreateOwnMix();
    setNarratorFlowSource(null);
    setStep("buildMix");
  }

  async function startTourFromSelection() {
    if (isCreateOwnSelected) {
      setNarratorFlowSource(null);
      setStep("buildMix");
      return;
    }
    if (!selectedRouteId || !selectedPersona) return;
    await startPresetTour(selectedRouteId, selectedPersona);
  }

  function startTourFromRoute(routeId: RouteDef["id"]) {
    selectPresetRoute(routeId);
  }

  async function startPresetTourFromRoute(routeId: RouteDef["id"]) {
    const selectedRoute = selectPresetRoute(routeId);
    if (!selectedRoute) return;
    await startPresetTour(routeId, selectedRoute.defaultPersona);
  }

  async function regeneratePresetRoute(routeId: RouteDef["id"]) {
    const selectedRoute = selectPresetRoute(routeId);
    if (!selectedRoute) return;
    await startPresetTour(routeId, selectedRoute.defaultPersona, { forceRegenerateAll: true });
  }

  function toggleBuilderStop(stop: CustomMixStop) {
    setErr(null);
    setBuilderSelectedStops((prev) => {
      const exists = prev.some((s) => stopMatches(s, stop));
      if (exists) {
        setBuildMixOrderedStops((ordered) => ordered.filter((s) => !stopMatches(s, stop)));
        return prev.filter((s) => !stopMatches(s, stop));
      }
      const nextMaxStops = getMaxStops();
      if (nextMaxStops > 0 && prev.length >= nextMaxStops) {
        setErr(`Select at most ${nextMaxStops} stops.`);
        return prev;
      }
      setBuildMixOrderedStops((ordered) => {
        const withoutExisting = ordered.filter((s) => !stopMatches(s, stop));
        return [...withoutExisting, stop];
      });
      return [...prev, stop];
    });
  }

  function moveSelectedStop(stop: CustomMixStop, direction: "up" | "down") {
    setErr(null);
    setBuilderSelectedStops((prev) => {
      const currentIdx = prev.findIndex((candidate) => stopMatches(candidate, stop));
      if (currentIdx < 0) return prev;
      const nextIdx = direction === "up" ? currentIdx - 1 : currentIdx + 1;
      const moved = moveItem(prev, currentIdx, nextIdx);
      if (moved === prev) return prev;

      setBuildMixOrderedStops((orderedPrev) => {
        const nonSelected = orderedPrev.filter(
          (candidate) => !moved.some((selected) => stopMatches(selected, candidate))
        );
        return [...moved, ...nonSelected];
      });

      return moved;
    });
  }

  function addSearchedCandidate(stop: CustomMixStop) {
    setErr(null);
    setSearchError(null);

    const stopCoordKey = getStopCoordKey(stop);
    const isDuplicate = builderSelectedStops.some(
      (selected) => selected.id === stop.id || getStopCoordKey(selected) === stopCoordKey
    );
    if (isDuplicate) {
      setSearchError("That stop is already selected.");
      return;
    }
    if (maxStopsForSelection > 0 && builderSelectedStops.length >= maxStopsForSelection) {
      setSearchError(`Select at most ${maxStopsForSelection} stops.`);
      return;
    }

    const nextStops = [...builderSelectedStops, stop];
    setBuilderSelectedStops(nextStops);
    setBuildMixOrderedStops((prev) => {
      const withoutIncoming = prev.filter((existing) => !stopMatches(existing, stop));
      return [stop, ...withoutIncoming];
    });
    setSearchCandidates((prev) => prev.filter((candidate) => !stopMatches(candidate, stop)));
    setSearchError(null);
  }

  function clearBuildMixSearch() {
    setSearchInput("");
    setSearchCandidates([]);
    setSearchError(null);
  }

  async function searchPlaces() {
    const query = searchInput.trim();
    if (!query) {
      setSearchError("Enter a place name to search.");
      return;
    }
    if (query.length < 2) {
      setSearchError("Enter at least 2 characters to search.");
      return;
    }

    setErr(null);
    setSearchError(null);
    setIsSearchingPlaces(true);

    try {
      const res = await fetch("/api/stops/search-places", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city: selectedCity, query, limit: 5 }),
      });
      const body = (await res.json()) as SearchPlacesResponse | { error?: string };
      if (!res.ok || !("candidates" in body)) {
        throw new Error(("error" in body && body.error) || "Failed to search places");
      }
      setSearchCandidates(body.candidates);
      if (body.candidates.length === 0) {
        setSearchError("No places found for that search.");
      }
    } catch (e) {
      setSearchCandidates([]);
      setSearchError(e instanceof Error ? e.message : "Failed to search places");
    } finally {
      setIsSearchingPlaces(false);
    }
  }

  function handleBuildMixSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (isSearchingPlaces) return;
    void searchPlaces();
  }

  useEffect(() => {
    if (searchInput.trim().length > 0) return;
    if (searchCandidates.length === 0 && !searchError) return;
    setSearchCandidates([]);
    setSearchError(null);
  }, [searchInput, searchCandidates.length, searchError]);

  async function startCustomMixGeneration(
    stopsOverride?: CustomMixStop[],
    personaOverride?: Persona,
    options?: StartCustomMixOptions
  ) {
    const stopsToGenerate = prioritizeOverviewById(stopsOverride ?? builderSelectedStops);
    const personaForGeneration = personaOverride ?? selectedPersona;
    const narratorGuidance =
      personaForGeneration === "custom"
        ? (options?.narratorGuidance ?? customNarratorGuidance).trim()
        : null;
    if (!stopsToGenerate.length || !personaForGeneration) return false;
    if (personaForGeneration === "custom" && !narratorGuidance) {
      setErr("Add narrator guidance to create a custom narrator.");
      return false;
    }
    const validation = validateMixSelection(30, "walk", stopsToGenerate.length, {
      minStops: options?.source === "instant" ? 1 : undefined,
    });
    if (!validation.ok) {
      setErr(validation.message);
      return false;
    }

    setErr(null);
    setIsGeneratingMix(true);
    setStep("generating");

    try {
      const body = await fetchJsonWithTimeout<{ error?: string; jamId?: string; jobId?: string }>(
        "/api/mix-jobs/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jamId: jam?.id ?? null,
            city: options?.cityOverride ?? customRouteCity,
            transportMode: "walk",
            lengthMinutes: 30,
            persona: personaForGeneration,
            stops: stopsToGenerate,
            source: options?.source ?? "manual",
            routeTitle: options?.routeTitle,
            narratorGuidance,
          }),
        },
        START_JOB_TIMEOUT_MS
      );
      if (!body.jamId || !body.jobId) {
        throw new Error("Missing generation job metadata");
      }
      setGenerationJobId(body.jobId);
      setGenerationJobKind("custom");
      setGenerationProgress(0);
      setGenerationStatusLabel(GENERATION_STATUS_LABELS.queued);
      setGenerationMessage("Queued");
      router.replace(`/?jam=${body.jamId}`);
      return true;
    } catch (e) {
      setGenerationJobKind(null);
      setErr(e instanceof Error ? e.message : "Failed to generate custom mix");
      setStep(options?.errorStep ?? "buildMix");
      return false;
    } finally {
      setIsGeneratingMix(false);
    }
  }

  function openEditStopsFromWalk() {
    if (!route) return;
    const baseStops: CustomMixStop[] = route.stops.map((s) => ({
      id: s.id,
      title: s.title,
      lat: s.lat,
      lng: s.lng,
      image: toSafeStopImage(s.images[0]),
    }));
    setErr(null);
    setIsEditingStopsFromWalk(true);
    setReturnToWalkOnClose(true);
    setBuilderSelectedStops(baseStops);
    setBuildMixOrderedStops(mergeUniqueStops(baseStops, availableStopsForCity));
    setSelectedPersona((jam?.persona ?? selectedPersona ?? "adult") as Persona);
    setStep("buildMix");
  }

  async function saveEditedStopsFromWalk() {
    if (!route) return;
    if (hasOffRouteAddsInEdit) {
      const started = await startCustomMixGeneration(builderSelectedStops);
      if (started) {
        setIsEditingStopsFromWalk(false);
        setReturnToWalkOnClose(false);
      }
      return;
    }
    const stopById = new Map(route.stops.map((s) => [s.id, s]));
    const nextStops = prioritizeOverviewById(
      builderSelectedStops
      .map((s) => stopById.get(s.id))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
    );

    if (nextStops.filter((s) => !s.isOverview).length < 1) {
      setErr("Choose at least 1 stop.");
      return;
    }

    const nextDescription =
      /\d+\s+stops?/.test(route.description)
        ? route.description.replace(/\d+\s+stops?/, formatStopCount(nextStops.length))
        : route.description;

    setCustomRoute({
      ...route,
      description: nextDescription,
      stops: nextStops,
    });
    setActiveStopIndex(null);
    setIsEditingStopsFromWalk(false);
    setReturnToWalkOnClose(false);
    setStep("walk");
  }

  async function restartWalk() {
    if (!jam) return;
    await updateJam({ current_stop: 0, completed_at: null });
    setStep(jam.route_id ? "walk" : "pickDuration");
  }

  // ---------- Init: load jam from URL ----------
  useEffect(() => {
    if (debugStepFromUrl === "generating") {
      setErr(null);
      setJam(null);
      setCustomRoute(null);
      setGenerationJobId(null);
      setGenerationJobKind(null);
      setGenerationProgress(42);
      setGenerationStatusLabel(GENERATION_STATUS_LABELS.generating_script);
      setGenerationMessage("Debug preview mode");
      setStep("generating");
      return;
    }

    if (!jamIdFromUrl) {
      setJam(null);
      setListenCount(0);
      setCustomRoute(null);
      setGenerationJobId(null);
      setGenerationJobKind(null);
      setStep("landing");
      return;
    }
    loadJamById(jamIdFromUrl);
  }, [jamIdFromUrl, debugStepFromUrl]);

  useEffect(() => {
    const jamId = jam?.id;
    if (!jamId) return;
    if (countedJamOpenRef.current.has(jamId)) return;
    countedJamOpenRef.current.add(jamId);

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/jams/${encodeURIComponent(jamId)}/listen`, {
          method: "POST",
          cache: "no-store",
        });
        const body = (await res.json()) as { error?: string; listen_count?: number };
        if (cancelled || !res.ok || typeof body.listen_count !== "number") return;
        setListenCount(Math.max(body.listen_count, 1));
      } catch {
        // Do not block walkthrough when listener analytics write fails.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [jam?.id]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const routeRef = jam?.route_id ?? null;
      if (!routeRef) {
        setCustomRoute(null);
        return;
      }
      try {
        await loadResolvedRoute(routeRef);
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "Failed to load route assets");
          setCustomRoute(null);
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [jam?.route_id, loadResolvedRoute]);

  useEffect(() => {
    if (step !== "generating" || !generationJobId || !generationJobKind) return;
    let cancelled = false;
    let nextPollTimeout: number | null = null;
    let pollAbortController: AbortController | null = null;
    let consecutivePollFailures = 0;

    const poll = async () => {
      if (cancelled) return;
      pollAbortController = new AbortController();
      const timeoutId = window.setTimeout(() => {
        pollAbortController?.abort();
      }, POLL_REQUEST_TIMEOUT_MS);

      try {
        const endpoint =
          generationJobKind === "custom"
            ? `/api/mix-jobs/${generationJobId}`
            : `/api/preset-jobs/${generationJobId}`;
        const res = await fetch(endpoint, { cache: "no-store", signal: pollAbortController.signal });
        window.clearTimeout(timeoutId);
        pollAbortController = null;
        const body = (await res.json()) as MixJobResponse | { error?: string };
        if (!res.ok || !("status" in body)) {
          throw new Error(("error" in body && body.error) || "Failed to poll generation status");
        }
        if (cancelled) return;
        consecutivePollFailures = 0;

        const nextProgress = Math.max(0, Math.min(100, Number(body.progress) || 0));
        setGenerationProgress(nextProgress);
        setGenerationStatusLabel(getGenerationStatusLabel(body.status));
        setGenerationMessage(body.message || "");

        if (body.status === "ready" || body.status === "ready_with_warnings") {
          setGenerationJobId(null);
          setGenerationJobKind(null);
          const routeRef = generationJobKind === "custom" ? `custom:${body.route_id}` : body.route_id;
          if (generationJobKind === "preset") {
            setGenerationStatusLabel("Preparing first stop");
            setGenerationMessage("Preparing first stop...");
          }
          const prepStartedAt = Date.now();
          const resolvedRoute = await loadResolvedRoute(routeRef);
          if (generationJobKind === "preset" && resolvedRoute) {
            const overviewStop = resolvedRoute.stops.find(
              (stop) => Boolean(stop.isOverview) || isPresetOverviewStopId(stop.id)
            );
            if (overviewStop) {
              const personaForPreload = selectedPersona ?? (jam?.persona ?? "adult");
              const overviewAudioUrl = (overviewStop.audio[personaForPreload] || "").trim();
              if (overviewAudioUrl) {
                const preloadResult = await preloadAudioMetadata(overviewAudioUrl, 4500);
                if (preloadResult !== "ready") {
                  setErr("Tour is ready. First stop audio is still buffering.");
                }
              } else {
                setErr("Tour is ready, but first stop audio is still unavailable.");
              }
            }
            const prepElapsed = Date.now() - prepStartedAt;
            if (prepElapsed < 1200) {
              await new Promise((resolve) => window.setTimeout(resolve, 1200 - prepElapsed));
            }
          }
          await loadJamById(body.jam_id);
          if (body.status === "ready_with_warnings") {
            setErr(body.error || body.message || "Tour is ready with warnings.");
          }
          return;
        }
        if (body.status === "failed") {
          setGenerationJobId(null);
          setGenerationJobKind(null);
          setErr(body.error || body.message || "Generation failed");
          setGenerationProgress(100);
          setGenerationStatusLabel(GENERATION_STATUS_LABELS.failed);
          setGenerationMessage(body.error || body.message || "Generation failed");
          return;
        }
      } catch (e) {
        window.clearTimeout(timeoutId);
        pollAbortController = null;
        if (cancelled) return;

        const isTimeoutError = e instanceof DOMException && e.name === "AbortError";
        consecutivePollFailures += 1;

        if (isTimeoutError) {
          console.warn(
            `generation poll timeout (${generationJobKind}) job=${generationJobId} failures=${consecutivePollFailures}`
          );
          setGenerationMessage("Status check timed out. Retrying...");
        } else {
          console.warn(
            `generation poll error (${generationJobKind}) job=${generationJobId} failures=${consecutivePollFailures}`,
            e
          );
        }

        if (consecutivePollFailures >= POLL_FAILURE_THRESHOLD) {
          setGenerationJobId(null);
          setGenerationJobKind(null);
          const message = "Status check timed out. Retry or return to home.";
          setErr(message);
          setGenerationProgress(100);
          setGenerationStatusLabel(GENERATION_STATUS_LABELS.failed);
          setGenerationMessage(message);
          return;
        }
      } finally {
        if (!cancelled && generationJobId && generationJobKind) {
          nextPollTimeout = window.setTimeout(() => {
            void poll();
          }, POLL_INTERVAL_MS);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (nextPollTimeout !== null) window.clearTimeout(nextPollTimeout);
      if (pollAbortController) pollAbortController.abort();
    };
  }, [step, generationJobId, generationJobKind, loadResolvedRoute, selectedPersona, jam?.persona]);

  useEffect(() => {
    if (!route) return;
    if (route.experienceKind === "follow_along" && step === "walk") {
      setStep("followAlongDrive");
      return;
    }
    if (route.experienceKind !== "follow_along" && step === "followAlongDrive") {
      setStep("walk");
    }
  }, [route, step]);

  useEffect(() => {
    if (!route || route.experienceKind !== "follow_along") return;
    setActiveStopIndex(
      typeof jam?.current_stop === "number" && jam.current_stop >= 0
        ? jam.current_stop
        : null
    );
  }, [route?.id, route?.experienceKind, jam?.current_stop]);

// ---------- watchPosition ----------
  useEffect(() => {
  if (step !== "walk") return;
  if (!navigator.geolocation) return;

  // If user never enabled geo, don't nag; banner will stay hidden.
  let watchId: number | null = null;

  try {
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const nextPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setMyPos(nextPos);
        setGeoAllowed(true);

        if (!currentStop) {
          setDistanceToStopM(null);
          setProximity("far");
          return;
        }

        const meters = haversineMeters(nextPos.lat, nextPos.lng, currentStop.lat, currentStop.lng);
        setDistanceToStopM(meters);

        // Thresholds (tweak later)
        if (meters <= 35) setProximity("arrived");
        else if (meters <= 80) setProximity("near");
        else setProximity("far");
      },
      () => {
        setGeoAllowed(false);
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 8000 }
    );
  } catch {
    // ignore
  }

  return () => {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  };
}, [step, currentStop]);

  useEffect(() => {
    if (step !== "followAlongDrive") return;
    if (!route || route.experienceKind !== "follow_along") return;
    const routeCoords = route.routePathCoords ?? null;
    if (!routeCoords || routeCoords.length < 2) return;
    if (!navigator.geolocation) return;

    let watchId: number | null = null;

    const evaluatePosition = async (
      nextPos: { lat: number; lng: number },
      speedMps: number | null
    ) => {
      setMyPos(nextPos);
      setGeoAllowed(true);

      const progress = normalizeRouteProgress(nextPos, routeCoords);
      setFollowAlongRouteProgressM(progress.distanceAlongMeters);

      const isOffRoute = progress.distanceToRouteMeters > 180;
      setFollowAlongOffRoute(isOffRoute);
      if (isOffRoute) {
        setFollowAlongStatusCopy("You drifted off route. Rejoin the route to resume stories.");
        return;
      }

      const nextStopIdx = nextFollowAlongStopIndex(currentStopIndex, route.stops);
      const nextStop = route.stops[nextStopIdx];
      if (!nextStop) {
        setFollowAlongStatusCopy("Drive in progress. You're approaching the end of the route.");
        return;
      }

      const trigger = shouldTriggerFollowAlongStop({
        routeCoords,
        myPos: nextPos,
        stop: nextStop,
        speedMps,
      });

      setDistanceToStopM(
        typeof trigger.aheadByMeters === "number" ? Math.max(0, trigger.aheadByMeters) : null
      );
      setFollowAlongStatusCopy(
        nextStop.stopKind === "arrival"
          ? "Final arrival story is queued as you reach your destination."
          : `Next story: ${nextStop.title}`
      );

      if (!trigger.shouldTrigger || activeStopIndex === nextStopIdx) return;

      setActiveStopIndex(nextStopIdx);
      setPendingAutoplayStopId(nextStop.id);
      await updateJam({ current_stop: nextStopIdx });
    };

    try {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const nextPos = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          };
          const last = followAlongLastPositionRef.current;
          let speedMps =
            typeof pos.coords.speed === "number" && Number.isFinite(pos.coords.speed)
              ? pos.coords.speed
              : null;
          if ((!speedMps || speedMps <= 0) && last) {
            const elapsedSeconds = Math.max(
              1,
              (pos.timestamp - last.timestamp) / 1000
            );
            speedMps =
              haversineMeters(last.lat, last.lng, nextPos.lat, nextPos.lng) /
              elapsedSeconds;
          }
          followAlongLastPositionRef.current = {
            ...nextPos,
            timestamp: pos.timestamp,
          };
          void evaluatePosition(nextPos, speedMps);
        },
        () => {
          setGeoAllowed(false);
        },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 8000 }
      );
    } catch {
      // ignore
    }

    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    };
  }, [step, route, currentStopIndex, activeStopIndex]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const onTimeUpdate = () => setAudioTime(el.currentTime || 0);
    const onLoadedMeta = () => {
      setAudioDuration(Number.isFinite(el.duration) ? el.duration : 0);
      setAudioTime(el.currentTime || 0);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);

    el.addEventListener("timeupdate", onTimeUpdate);
    el.addEventListener("loadedmetadata", onLoadedMeta);
    el.addEventListener("durationchange", onLoadedMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    onLoadedMeta();

    return () => {
      el.removeEventListener("timeupdate", onTimeUpdate);
      el.removeEventListener("loadedmetadata", onLoadedMeta);
      el.removeEventListener("durationchange", onLoadedMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
    };
  }, [currentStop?.id, persona]);

  useEffect(() => {
    if (step !== "followAlongDrive") return;
    if (!route || route.experienceKind !== "follow_along") return;
    const routeCoords = route.routePathCoords ?? null;
    if (!routeCoords || routeCoords.length < 2) return;

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      void requestCurrentGeoPosition()
        .then((coords) => {
          const progress = normalizeRouteProgress(coords, routeCoords);
          setMyPos(coords);
          setFollowAlongRouteProgressM(progress.distanceAlongMeters);
          setFollowAlongOffRoute(progress.distanceToRouteMeters > 180);
          setGeoAllowed(true);
        })
        .catch(() => {
          setGeoAllowed(false);
        });
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [step, route]);

  useEffect(() => {
    if (!pendingAutoplayStopId) return;
    if (!currentStop || currentStop.id !== pendingAutoplayStopId) return;
    if (!hasCurrentAudio) {
      setPendingAutoplayStopId(null);
      return;
    }
    const el = audioRef.current;
    if (!el) return;
    void el.play().catch(() => {
      // ignore autoplay interruption errors
    });
    setPendingAutoplayStopId(null);
  }, [pendingAutoplayStopId, currentStop, hasCurrentAudio]);

  useEffect(() => {
    if (step !== "walk" && step !== "followAlongDrive") return;
    setActiveStopIndex(null);
    setPendingAutoplayStopId(null);
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    setIsPlaying(false);
    setAudioTime(0);
    setAudioDuration(0);
  }, [step, route?.id]);

  useEffect(() => {
    if (step !== "pickDuration") return;
    if (returnToWalkOnClose && jam?.route_id) {
      const presetRoute = getRouteById(jam.route_id);
      const routeId = presetRoute ? jam.route_id : null;
      if (presetRoute?.city) {
        setSelectedCity(presetRoute.city);
      }
      setSelectedRouteId(routeId);
      setSelectedPersona((jam.persona ?? null) as Persona | null);
      if ((jam.persona ?? null) !== "custom") {
        setCustomNarratorGuidance((current) => current.trim());
      }
      setNarratorFlowSource("walkEdit");
      setPickDurationPage("narrator");
      return;
    }
  }, [step, returnToWalkOnClose, jam?.route_id, jam?.persona]);

  useEffect(() => {
    previousStepRef.current = step;
  }, [step]);

  useEffect(() => {
    if (step !== "buildMix") return;
    if (!isEditingStopsFromWalk && narratorFlowSource !== "buildMix") {
      setBuilderSelectedStops([]);
      setBuildMixOrderedStops([]);
      setSelectedPersona(null);
      setCustomNarratorGuidance("");
      setInstantDiscoveryCity(null);
    }
    setSearchInput("");
    setSearchCandidates([]);
    setSearchError(null);
    setGenerationJobId(null);
    setGenerationJobKind(null);
    setGenerationProgress(0);
    setGenerationStatusLabel(GENERATION_STATUS_LABELS.queued);
    setGenerationMessage("Queued");
  }, [step, isEditingStopsFromWalk, narratorFlowSource, availableStopsForCity]);

  useEffect(() => {
    if (step !== "buildMix") return;
    if (myPos) return;
    let cancelled = false;

    void requestCurrentGeoPosition()
      .then((coords) => {
        if (cancelled) return;
        setMyPos(coords);
        setGeoAllowed(true);
      })
      .catch(() => {
        if (cancelled) return;
        setGeoAllowed(false);
      });

    return () => {
      cancelled = true;
    };
  }, [step, myPos]);

  useEffect(() => {
    if (!["landing", "pickDuration", "buildMix", "followAlongSetup", "generating", "walk", "followAlongDrive"].includes(step)) return;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [step]);

  useEffect(() => {
    return () => {
      if (scriptModalCloseTimeoutRef.current) {
        window.clearTimeout(scriptModalCloseTimeoutRef.current);
      }
    };
  }, []);

  const stopList = useMemo(() => {
    if (!route) return [];
    const selectedIdx = currentStopIndex ?? -1;
    return route.stops.map((stop, idx) => {
      if (selectedIdx < 0) {
        if (stop.isOverview) {
          return {
            id: stop.id,
            title: stop.title,
            isOverview: true,
            image: toSafeStopImage(stop.images[0]),
            subtitle: "Starting point",
            isActive: false,
          };
        }
        const fallbackMinutes =
          idx > 0
            ? estimateWalkMinutes(
                haversineMeters(route.stops[idx - 1].lat, route.stops[idx - 1].lng, stop.lat, stop.lng)
              )
            : 1;
        return {
          id: stop.id,
          title: stop.title,
          isOverview: Boolean(stop.isOverview),
          image: toSafeStopImage(stop.images[0]),
          subtitle: `${fallbackMinutes} mins away`,
          isActive: false,
        };
      }

      let subtitle = stop.isOverview ? "Starting point" : "At this location";
      if (idx < selectedIdx) subtitle = stop.isOverview ? "Starting point" : "Visited";
      if (idx > selectedIdx && !stop.isOverview) {
        const prev = route.stops[idx - 1];
        const meters = haversineMeters(prev.lat, prev.lng, stop.lat, stop.lng);
        subtitle = `${estimateWalkMinutes(meters)} min walk away`;
      }
      return {
        id: stop.id,
        title: stop.title,
        isOverview: Boolean(stop.isOverview),
        image: toSafeStopImage(stop.images[0]),
        subtitle,
        isActive: idx === selectedIdx,
      };
    });
  }, [route, currentStopIndex]);

  const mapsUrl = useMemo(() => {
    if (!route) return "#";
    const originPoint = route.origin ?? (route.stops[0] ? { lat: route.stops[0].lat, lng: route.stops[0].lng } : null);
    const destinationPoint =
      route.destination ??
      (route.stops[route.stops.length - 1]
        ? {
            lat: route.stops[route.stops.length - 1].lat,
            lng: route.stops[route.stops.length - 1].lng,
          }
        : null);
    if (!originPoint || !destinationPoint) return "#";
    const origin = `${originPoint.lat},${originPoint.lng}`;
    const destination = `${destinationPoint.lat},${destinationPoint.lng}`;
    const waypoints = route.stops
      .filter((stop) => stop.stopKind !== "arrival")
      .map((s) => `${s.lat},${s.lng}`)
      .join("|");
    const mode = route.transportMode === "drive" ? "driving" : "walking";
    const base = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=${mode}`;
    return waypoints ? `${base}&waypoints=${encodeURIComponent(waypoints)}` : base;
  }, [route]);
  const buildMixSubmitDisabled = isEditingStopsFromWalk ? isGeneratingMix : (!selectionValidation.ok || isGeneratingMix);
  const isSurpriseMixUnavailable = !isNearbyStoryEnabled;
  const isSurpriseMixLoading = isGeneratingNearbyStory || isResolvingNearbyGeo;
  const isSurpriseMixDisabled = isSurpriseMixUnavailable || isSurpriseMixLoading;
  const surpriseMixSubtitle = isResolvingNearbyGeo
    ? "Locating..."
    : isGeneratingNearbyStory
      ? "Generating..."
      : isSurpriseMixUnavailable
        ? "Coming soon"
        : "One nearby landmark. Story by AI Historian.";

  // ---------- UI ----------
  return (
    <div className={`${styles.container} ${step === "walk" || step === "followAlongDrive" || step === "landing" || step === "pickDuration" || step === "buildMix" || step === "followAlongSetup" || step === "generating" ? styles.containerWide : ""}`}>
      {step !== "walk" && step !== "followAlongDrive" && step !== "landing" && step !== "pickDuration" && step !== "buildMix" && step !== "followAlongSetup" && step !== "generating" && (
        <header className={styles.header}>
          <div>
            <button type="button" onClick={goHome} className={`${styles.brandLink} ${styles.brandTitle}`}>Wandrful</button>
          </div>

          <div className={styles.headerActions}>
            {jam && (
              <button
                onClick={copyShareLink}
                className={styles.button}
              >
                Share
              </button>
            )}
          </div>
        </header>
      )}

      {err && (
        <div className={styles.error}>
          {err}
        </div>
      )}

      {/* LANDING */}
      {step === "landing" && (
        <main
          className={`${styles.landingLayout} ${landingTheme === "light" ? styles.landingThemeLight : styles.landingThemeDark}`}
          data-theme={landingTheme}
        >
          <section className={styles.landingImagePane}>
            <video
              className={styles.landingVideo}
              autoPlay
              loop
              muted
              playsInline
              preload="auto"
              aria-hidden="true"
            >
              <source src="/images/marketing/ginger-walking-remix-v2.mp4" type="video/mp4" />
            </video>
            <div className={styles.landingVideoScrim} aria-hidden="true" />
            <div className={styles.landingMobileHeroContent}>
              <button type="button" onClick={goHome} className={`${styles.brandLink} ${styles.landingBrand} ${styles.landingMobileBrand}`}>
                <Image
                  src="/images/marketing/Wandrful-logo-v2.svg"
                  alt="Wandrful"
                  width={65}
                  height={60}
                  className={styles.landingLogo}
                />
              </button>
              <div className={`${styles.landingCopyBlock} ${styles.landingCopyBlockMobile}`}>
                <h1 className={styles.landingHeading}>A mixtape for&nbsp;the&nbsp;streets</h1>
                <p className={styles.landingCopy}>
                  Wander with intention. Experience places through curated stories. <strong>More story. Less directions.</strong>
                </p>
              </div>
            </div>
          </section>

          <section className={styles.landingInfo}>
            <div className={styles.landingDesktopIntro}>
              <button type="button" onClick={goHome} className={`${styles.brandLink} ${styles.landingBrand}`}>
                <Image
                  src="/images/marketing/Wandrful-logo.svg"
                  alt="Wandrful"
                  width={65}
                  height={60}
                  className={styles.landingLogo}
                />
              </button>
              <div className={styles.landingCopyBlock}>
                <h1 className={styles.landingHeading}>A mixtape for&nbsp;the&nbsp;streets.</h1>
                <p className={styles.landingCopy}>
                  Wander with intention. Experience places through a curated lens. <strong>More story. Less directions.</strong>
                </p>
              </div>
            </div>

            {featuredPresetSections.map((section) => (
              <div key={section.title}>
                <div className={styles.landingPopular}>{section.title}</div>

                <div className={styles.landingFeaturedGrid}>
                  {section.routes.map((r) => {
                    const pricingLabel = getRoutePricingLabel(r.pricing);
                    const stopCountLabel = formatStopCount(getPresetRouteStopCount(r));
                    const narratorLabel = getPresetRouteNarratorLabel(r);
                    const isRoutePending = pendingPresetRouteAction?.routeId === r.id;

                    return (
                      <div key={r.id} className={styles.landingFeaturedCardShell}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedCity(r.city ?? "salem");
                            void startPresetTourFromRoute(r.id);
                          }}
                          disabled={isRoutePending}
                          aria-label={`${r.title}, ${pricingLabel}, ${stopCountLabel}, story by ${narratorLabel}`}
                          className={`${styles.landingFeaturedCard} ${selectedRouteId === r.id ? styles.landingFeaturedCardSelected : ""}`}
                          style={{ backgroundImage: `url("${getLandingRouteImage(r)}")` }}
                        >
                          <div className={styles.landingFeaturedCardOverlay} aria-hidden="true" />
                          <div className={styles.landingFeaturedCardPricePill} aria-hidden="true">
                            {pricingLabel}
                          </div>
                          <div className={styles.landingFeaturedCardContent}>
                            <div className={styles.landingFeaturedCardSpacer} aria-hidden="true" />
                            <div className={styles.landingFeaturedCardTitleWrap}>
                              <div className={`${styles.landingFeaturedCardTitle} ${getLandingTitleStyleClass(r.id)} ${getLandingTitleFontClass(r.id)}`}>
                                {r.title}
                              </div>
                            </div>
                            <div className={styles.landingFeaturedCardMeta}>
                              <div className={styles.landingFeaturedCardBadge} aria-hidden="true">
                                <Image
                                  src={getPresetRouteIcon()}
                                  alt=""
                                  width={20}
                                  height={20}
                                  className={styles.landingFeaturedCardBadgeIcon}
                                  aria-hidden="true"
                                />
                              </div>
                              <div className={styles.landingFeaturedCardMetaText}>
                                <div className={styles.landingFeaturedCardMetaPrimary}>{stopCountLabel}</div>
                                <div className={styles.landingFeaturedCardMetaSecondary}>
                                  Story by {narratorLabel}
                                </div>
                              </div>
                            </div>
                          </div>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            <div className={styles.landingSecondaryLabel}>More ways to start</div>

            <div className={`${styles.pickRouteList} ${styles.landingRouteList}`}>
              <button
                type="button"
                onClick={() => {
                  setSelectedCity("salem");
                  setInstantDiscoveryCity(null);
                  goToCreateOwnMixBuilder();
                }}
                className={`${styles.pickRouteRow} ${styles.landingSecondaryRow} ${isCreateOwnSelected ? styles.pickRouteRowSelected : ""}`}
              >
                <div className={styles.pickRouteMainWithIcon}>
                  <div className={styles.pickRouteIconCircle} aria-hidden="true">
                    <Image
                      src="/icons/shuffle.svg"
                      alt=""
                      width={24}
                      height={24}
                      className={styles.pickRouteWalkIcon}
                      aria-hidden="true"
                    />
                  </div>
                  <div className={styles.pickRouteMain}>
                    <div className={styles.pickRouteTitle}>Create your mix</div>
                    <div className={styles.pickRouteMeta}>Pick your stops. Choose a storyteller.</div>
                    <div className={`${styles.pickRouteMeta} ${styles.pickRouteMetaSecondary}`}>
                      Publish for $1.99 and set your listening price.
                    </div>
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  void handleNearbyStory();
                }}
                className={`${styles.pickRouteRow} ${styles.landingSecondaryRow} ${isSurpriseMixDisabled ? styles.pickRouteRowDisabled : ""}`}
                disabled={isSurpriseMixDisabled}
              >
                <div className={styles.pickRouteMainWithIcon}>
                  <div className={styles.pickRouteIconCircle} aria-hidden="true">
                    <Image
                      src="/icons/lightning-fill.svg"
                      alt=""
                      width={24}
                      height={24}
                      className={styles.pickRouteWalkIcon}
                      aria-hidden="true"
                    />
                  </div>
                  <div className={styles.pickRouteMain}>
                    <div className={styles.pickRouteTitle}>My Location</div>
                    <div className={styles.pickRouteMeta}>{surpriseMixSubtitle}</div>
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  void openFollowAlongSetup();
                }}
                className={`${styles.pickRouteRow} ${styles.landingSecondaryRow}`}
              >
                <div className={styles.pickRouteMainWithIcon}>
                  <div className={styles.pickRouteIconCircle} aria-hidden="true">
                    <Image
                      src="/icons/play-fill.svg"
                      alt=""
                      width={24}
                      height={24}
                      className={styles.pickRouteWalkIcon}
                      aria-hidden="true"
                    />
                  </div>
                  <div className={styles.pickRouteMain}>
                    <div className={styles.pickRouteTitle}>Follow along</div>
                    <div className={styles.pickRouteMeta}>Pick one destination. Stories appear as you drive.</div>
                  </div>
                </div>
              </button>

              {INSTAGRAM_IMPORT_ENABLED ? (
                <button
                  type="button"
                  onClick={() => {
                    router.push("/import/instagram");
                  }}
                  className={`${styles.pickRouteRow} ${styles.landingSecondaryRow}`}
                >
                  <div className={styles.pickRouteMainWithIcon}>
                    <div className={styles.pickRouteIconCircle} aria-hidden="true">
                      <Image
                        src="/icons/file-earmark-text.svg"
                        alt=""
                        width={24}
                        height={24}
                        className={styles.pickRouteWalkIcon}
                        aria-hidden="true"
                      />
                    </div>
                    <div className={styles.pickRouteMain}>
                      <div className={styles.pickRouteTitle}>Instagram</div>
                      <div className={styles.pickRouteMeta}>Paste a public post. Turn it into a draft.</div>
                    </div>
                  </div>
                </button>
              ) : null}
            </div>

            <div className={styles.landingSecondaryLabel}>Locations</div>

            <div className={`${styles.pickRouteList} ${styles.landingRouteList}`}>
              <button
                type="button"
                onClick={() => {
                  openPresetCity("nyc");
                }}
                className={`${styles.pickRouteRow} ${styles.landingSecondaryRow}`}
              >
                <div className={styles.pickRouteMainWithIcon}>
                  <div className={styles.pickRouteIconCircle} aria-hidden="true">
                    <Image
                      src="/icons/geo-alt-fill.svg"
                      alt=""
                      width={24}
                      height={24}
                      className={styles.pickRouteWalkIcon}
                      aria-hidden="true"
                    />
                  </div>
                  <div className={styles.pickRouteMain}>
                    <div className={styles.pickRouteTitle}>New York City</div>
                    <div className={styles.pickRouteMeta}>Architecture, city animals, superheroes, and weird history.</div>
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  openPresetCity("boston");
                }}
                className={`${styles.pickRouteRow} ${styles.landingSecondaryRow}`}
              >
                <div className={styles.pickRouteMainWithIcon}>
                  <div className={styles.pickRouteIconCircle} aria-hidden="true">
                    <Image
                      src="/icons/geo-alt-fill.svg"
                      alt=""
                      width={24}
                      height={24}
                      className={styles.pickRouteWalkIcon}
                      aria-hidden="true"
                    />
                  </div>
                  <div className={styles.pickRouteMain}>
                    <div className={styles.pickRouteTitle}>Boston</div>
                    <div className={styles.pickRouteMeta}>Revolutionary secrets and old taverns.</div>
                  </div>
                </div>
              </button>
            </div>

            <div className={styles.landingFooter}>
              <button
                type="button"
                role="switch"
                aria-checked={landingTheme === "light"}
                aria-label={`Switch to ${nextLandingTheme} mode`}
                onClick={toggleLandingTheme}
                className={styles.landingThemeToggle}
              >
                <span className={styles.landingThemeToggleCopy}>
                  <span className={styles.landingThemeToggleLabel}>Theme</span>
                  <span className={styles.landingThemeToggleValue}>
                    {landingTheme === "dark" ? "Dark mode" : "Light mode"}
                  </span>
                </span>
                <span className={styles.landingThemeToggleTrack} aria-hidden="true">
                  <span className={styles.landingThemeToggleThumb} />
                </span>
              </button>
            </div>
          </section>
        </main>
      )}

{/* banner UI inside the WALK section
*/}
{geoAllowed === true && proximity !== "far" && distanceToStopM !== null && (
  <div className={styles.proximityBanner}>
    <div className={styles.compactText}>
      <div className={styles.strongText}>
        {proximity === "arrived" ? "Arrived 🎧" : "You’re close"}
      </div>
      <div className={styles.narrationLabel}>
        About {formatDistance(distanceToStopM)} from <b>{currentStop?.title}</b>
      </div>
    </div>

    <button onClick={startStopNarration} className={styles.button} disabled={!hasCurrentAudio}>
      {hasCurrentAudio ? "Start stop" : "Audio pending"}
    </button>
  </div>
      )}

      {/* PICK DURATION */}
      {step === "pickDuration" && (
        <main className={styles.pickLayout}>
          {pickDurationPage === "narrator" && (
            <>
              <section className={`${styles.pickInfo} ${styles.pickInfoSelectRoute}`}>
                <button onClick={closeNarratorPicker} className={`${styles.mapBackButton} ${styles.mapBackButtonInverted} ${styles.pickCloseButtonLeft} ${styles.pickCloseButtonDesktop}`} aria-label="Back">
                  <Image
                    src="/icons/arrow-left.svg"
                    alt=""
                    width={26}
                    height={26}
                    className={styles.mapBackIconDark}
                    aria-hidden="true"
                  />
                </button>
                <h2 className={`${styles.pickHeading} ${styles.pickHeadingBelowClose}`}>Select your storyteller</h2>
                <div className={styles.pickPersonaRow}>
                  {PERSONA_KEYS.map((personaKey) => {
                    const personaInfo = personaCatalog[personaKey];
                    return (
                    <button
                      key={personaKey}
                      onClick={() => {
                        void handleNarratorSelect(personaKey);
                      }}
                      className={`${styles.pickNarratorOption} ${selectedPersona === personaKey ? styles.pickNarratorOptionSelected : ""}`}
                    >
                        <div className={styles.pickNarratorOptionContent}>
                          <div className={styles.pickNarratorWithAvatar}>
                            <div className={styles.pickNarratorAvatarWrap}>
                            {usesNarratorIcon(personaKey) ? (
                              <Image
                                src="/icons/stars.svg"
                                alt=""
                                width={24}
                                height={24}
                                className={styles.pickNarratorFutureIcon}
                                aria-hidden="true"
                              />
                            ) : (
                              <Image
                                src={personaInfo.avatarSrc}
                                alt={personaInfo.avatarAlt}
                                fill
                                className={styles.pickNarratorAvatar}
                              />
                            )}
                          </div>
                          <div>
                            <div className={styles.pickRouteTitle}>{personaInfo.displayName}</div>
                            <div className={styles.pickNarratorSub}>{personaInfo.description}</div>
                          </div>
                        </div>
                        <div className={styles.pickRowArrow} aria-hidden="true">
                          <Image
                            src="/icons/chevron-right.svg"
                            alt=""
                            width={28}
                            height={28}
                            className={styles.landingArrowIcon}
                            aria-hidden="true"
                          />
                        </div>
                      </div>
                    </button>
                    );
                  })}
                  <button
                    type="button"
                    disabled={!customNarratorEnabled}
                    aria-disabled={!customNarratorEnabled}
                    onClick={() => {
                      if (!customNarratorEnabled) return;
                      handleNarratorSelect("custom");
                    }}
                    className={`${styles.pickNarratorOption} ${selectedPersona === "custom" ? styles.pickNarratorOptionSelected : ""} ${!customNarratorEnabled ? styles.pickNarratorOptionDisabled : ""}`}
                  >
                    <div className={styles.pickNarratorOptionContent}>
                      <div className={styles.pickNarratorWithAvatar}>
                        <div className={styles.pickNarratorAvatarWrap}>
                          <Image
                            src="/icons/stars.svg"
                            alt=""
                            width={24}
                            height={24}
                            className={styles.pickNarratorFutureIcon}
                            aria-hidden="true"
                          />
                        </div>
                        <div>
                          <div className={styles.pickRouteTitle}>Create your own storyteller</div>
                          <div className={styles.pickNarratorSub}>
                            {customNarratorEnabled ? "Describe the voice, audience, and tone you want." : "Available for custom tours only"}
                          </div>
                        </div>
                      </div>
                      <div className={styles.pickRowArrow} aria-hidden="true">
                        <Image
                          src="/icons/chevron-right.svg"
                          alt=""
                          width={28}
                          height={28}
                          className={styles.landingArrowIcon}
                          aria-hidden="true"
                        />
                      </div>
                    </div>
                  </button>
                </div>
                {customNarratorEnabled && selectedPersona === "custom" && (
                  <div className={styles.customNarratorPanel}>
                    <label htmlFor="customNarratorGuidance" className={styles.customNarratorLabel}>
                      Describe your narrator
                    </label>
                    <p className={styles.customNarratorHelp}>
                      {customNarratorHelpText}
                    </p>
                    <textarea
                      id="customNarratorGuidance"
                      value={customNarratorGuidance}
                      onChange={(e) => {
                        setErr(null);
                        setCustomNarratorGuidance(e.target.value.slice(0, CUSTOM_NARRATOR_MAX_CHARS));
                      }}
                      className={styles.customNarratorTextarea}
                      placeholder={customNarratorPlaceholder}
                      rows={6}
                      maxLength={CUSTOM_NARRATOR_MAX_CHARS}
                    />
                    <div className={styles.customNarratorCount}>
                      {trimmedCustomNarratorGuidance.length}/{CUSTOM_NARRATOR_MAX_CHARS}
                    </div>
                  </div>
                )}
                {customNarratorEnabled && (
                  <div className={styles.pickDurationStartWrap}>
                    <button
                      type="button"
                      onClick={() => {
                        void submitNarratorSelection();
                      }}
                      disabled={narratorSubmitDisabled}
                      className={`${styles.landingCtaButton} ${styles.startTourButton}`}
                    >
                      {narratorSubmitLabel}
                    </button>
                  </div>
                )}
              </section>

              <section className={styles.pickImagePane}>
                <RouteMap
                  stops={narratorPreviewStops}
                  currentStopIndex={0}
                  myPos={myPos}
                  cityCenter={narratorPreviewCityCenter}
                  followCurrentStop={false}
                  showRoutePath={narratorPreviewShowRoutePath}
                  routeCoords={narratorPreviewRouteCoords}
                  routeTravelMode={narratorPreviewRouteTravelMode}
                  endpoints={narratorPreviewEndpoints}
                />
                <button onClick={closeNarratorPicker} className={`${styles.mapBackButton} ${styles.mapBackButtonInverted} ${styles.pickCloseButtonMapMobile}`} aria-label="Back">
                  <Image
                    src="/icons/arrow-left.svg"
                    alt=""
                    width={26}
                    height={26}
                    className={styles.mapBackIconDark}
                    aria-hidden="true"
                  />
                </button>
              </section>
            </>
          )}
          {pickDurationPage === "routes" && (
            <>
              <section className={`${styles.pickInfo} ${styles.pickInfoSelectRoute}`}>
                <button onClick={closeRoutePicker} className={`${styles.mapBackButton} ${styles.mapBackButtonInverted} ${styles.pickCloseButtonLeft} ${styles.pickCloseButtonDesktop}`} aria-label="Back">
                  <Image
                    src="/icons/arrow-left.svg"
                    alt=""
                    width={26}
                    height={26}
                    className={styles.mapBackIconDark}
                    aria-hidden="true"
                  />
                </button>
                <div className={styles.pickCopyBlock}>
                  <h2 className={styles.pickHeading}>
                    Choose your route in{" "}
                    <button type="button" className={styles.pickHeadingCityLink} onClick={goHome}>
                      {selectedCityLabel}
                    </button>
                  </h2>
                </div>

                <div className={styles.pickRouteList}>
                  {routesForSelectedCity.map((r) => {
                    const isRoutePending = pendingPresetRouteAction?.routeId === r.id;

                    return (
                    <div
                      key={r.id}
                      className={`${styles.pickRouteRow} ${selectedRouteId === r.id ? styles.pickRouteRowSelected : ""}`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          startTourFromRoute(r.id);
                        }}
                        disabled={isRoutePending}
                        className={styles.pickRoutePrimaryButton}
                      >
                        <div className={styles.pickRouteMainWithIcon}>
                          <div className={styles.pickRouteIconCircle} aria-hidden="true">
                            <Image
                              src={getPresetRouteIcon()}
                              alt=""
                              width={24}
                              height={24}
                              className={styles.pickRouteWalkIcon}
                              aria-hidden="true"
                            />
                          </div>
                          <div className={styles.pickRouteMain}>
                            <div className={styles.pickRouteTitle}>{r.title}</div>
                            <div className={styles.pickRouteMeta}>
                              Story by {getPresetRouteNarratorLabel(r)}
                            </div>
                            <div className={`${styles.pickRouteMeta} ${styles.pickRouteMetaSecondary}`}>
                              {r.durationLabel} • {formatStopCount(getPresetRouteStopCount(r))}
                            </div>
                          </div>
                        </div>
                        <div className={styles.pickRowArrow} aria-hidden="true">
                          <Image
                            src="/icons/chevron-right.svg"
                            alt=""
                            width={28}
                            height={28}
                            className={styles.landingArrowIcon}
                            aria-hidden="true"
                          />
                        </div>
                      </button>
                    </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => {
                      setNarratorFlowSource(null);
                      setStep("buildMix");
                    }}
                    className={styles.pickRouteRow}
                    >
                      <div className={styles.pickRouteMainWithIcon}>
                      <div className={styles.pickRouteIconCircle} aria-hidden="true">
                        <Image
                          src="/icons/shuffle.svg"
                          alt=""
                          width={24}
                          height={24}
                          className={styles.pickRouteWalkIcon}
                          aria-hidden="true"
                        />
                      </div>
                        <div className={styles.pickRouteMain}>
                          <div className={styles.pickRouteTitle}>Create your mix</div>
                          <div className={styles.pickRouteMeta}>Select up to 10 stops</div>
                        </div>
                      </div>
                      <div className={styles.pickRowArrow} aria-hidden="true">
                        <Image
                          src="/icons/chevron-right.svg"
                          alt=""
                          width={28}
                          height={28}
                          className={styles.landingArrowIcon}
                          aria-hidden="true"
                        />
                      </div>
                    </button>
                </div>
              </section>

              <section className={styles.pickImagePane}>
                <RouteMap
                  stops={selectedRoute ? selectedRoute.stops : []}
                  currentStopIndex={0}
                  myPos={myPos}
                  cityCenter={selectedCityCenter}
                  followCurrentStop={false}
                />
                <button onClick={closeRoutePicker} className={`${styles.mapBackButton} ${styles.mapBackButtonInverted} ${styles.pickCloseButtonMapMobile}`} aria-label="Back">
                  <Image
                    src="/icons/arrow-left.svg"
                    alt=""
                    width={26}
                    height={26}
                    className={styles.mapBackIconDark}
                    aria-hidden="true"
                  />
                </button>
              </section>
            </>
          )}
        </main>
      )}

      {step === "buildMix" && (
        <main className={`${styles.pickLayout} ${styles.buildMixLayout}`}>
          <section className={`${styles.pickInfo} ${styles.buildMixInfo}`}>
            <button
              onClick={closeRoutePicker}
              className={`${styles.mapBackButton} ${styles.mapBackButtonInverted} ${styles.pickCloseButtonLeft} ${styles.pickCloseButtonDesktop}`}
              aria-label="Close"
            >
              <Image
                src="/icons/x.svg"
                alt=""
                width={26}
                height={26}
                className={styles.mapBackIconDark}
                aria-hidden="true"
              />
            </button>
            <div className={styles.pickCopyBlock}>
              <h2 className={styles.pickHeading}>Create your mix</h2>
            </div>

            
            <div className={styles.buildMixLinkAddWrap}>
              <div className={styles.buildMixSearchRow}>
                <div className={styles.buildMixSearchInputWrap}>
                  <input
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={handleBuildMixSearchKeyDown}
                    className={styles.buildMixSearchInput}
                    placeholder={`Search for a place`}
                    aria-label="Search places"
                  />
                  <div className={styles.buildMixSearchActions}>
                    {searchInput.trim().length > 0 && (
                      <button
                        type="button"
                        onClick={clearBuildMixSearch}
                        className={styles.buildMixSearchActionButton}
                        aria-label="Clear search"
                      >
                        <svg viewBox="0 0 24 24" className={styles.buildMixSearchClearIcon} aria-hidden="true">
                          <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                          <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={searchPlaces}
                      disabled={isSearchingPlaces}
                      className={styles.buildMixSearchActionButton}
                      aria-label={isSearchingPlaces ? "Searching places" : "Search places"}
                    >
                      <svg viewBox="0 0 24 24" className={styles.buildMixSearchIcon} aria-hidden="true">
                        <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
                        <line x1="16.2" y1="16.2" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
              {searchError && <div className={styles.buildMixSearchError}>{searchError}</div>}
              {searchInput.trim().length > 0 && availableSearchCandidates.length > 0 && (
                <div className={styles.buildMixSearchDropdown}>
                  {availableSearchCandidates.map((candidate) => (
                      <div
                        key={candidate.id}
                        className={styles.buildMixSearchDropdownRow}
                      >
                        <div className={styles.buildMixSearchDropdownTitle}>{candidate.title}</div>
                        <button
                          type="button"
                          onClick={() => addSearchedCandidate(candidate)}
                          className={styles.pickRouteToggleButton}
                          aria-label={`Add ${candidate.title}`}
                        >
                          <div className={styles.pickRouteArrow}>
                            <div className={styles.pickRouteIconCircle} aria-hidden="true">
                              <Image
                                src="/icons/plus.svg"
                                alt=""
                                width={20}
                                height={20}
                                className={styles.pickRouteArrowIcon}
                                aria-hidden="true"
                              />
                            </div>
                          </div>
                        </button>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
            <div className={styles.pickSectionLabel}>
               
              {builderSelectedStops.length} of {maxStopsForSelection || 0} stops selected  for {formatRouteMiles(selectedStopsDistanceMiles)}
            </div>
            <div className={styles.pickRouteList}>
              {buildMixDisplayStops.length === 0 ? (
                null
              ) : (
                buildMixDisplayStops.map((stop, idx) => {
                  const stopCoordKey = getStopCoordKey(stop);
                  const active = builderSelectedStops.some(
                    (s) => s.id === stop.id || getStopCoordKey(s) === stopCoordKey
                  );
                  const isFirst = idx === 0;
                  const isLast = idx === buildMixDisplayStops.length - 1;
                  return (
                    <div
                      key={stop.id}
                      className={`${styles.pickRouteRow} ${styles.pickRouteRowBuildMix} ${active ? styles.pickRouteRowSelected : ""}`}
                    >
                      <div className={styles.pickRouteMain}>
                        <div className={styles.buildMixTitleRow}>
                          <div className={styles.buildMixReorderButtons}>
                            <button
                              type="button"
                              className={styles.buildMixReorderButton}
                              onClick={() => moveSelectedStop(stop, "up")}
                              aria-label={`Move ${stop.title} up`}
                              disabled={isFirst}
                            >
                              <Image
                                src="/icons/chevron-right.svg"
                                alt=""
                                width={16}
                                height={16}
                                className={`${styles.buildMixReorderIcon} ${styles.buildMixReorderIconUp}`}
                                aria-hidden="true"
                              />
                            </button>
                            <button
                              type="button"
                              className={styles.buildMixReorderButton}
                              onClick={() => moveSelectedStop(stop, "down")}
                              aria-label={`Move ${stop.title} down`}
                              disabled={isLast}
                            >
                              <Image
                                src="/icons/chevron-right.svg"
                                alt=""
                                width={16}
                                height={16}
                                className={`${styles.buildMixReorderIcon} ${styles.buildMixReorderIconDown}`}
                                aria-hidden="true"
                              />
                            </button>
                          </div>
                          <div className={`${styles.pickRouteTitle} ${styles.buildMixStopTitleWithIndex}`}>{`${idx + 1}. ${stop.title}`}</div>
                        </div>
                      </div>
                      <button
                        type="button"
                        className={styles.pickRouteToggleButton}
                        onClick={() => toggleBuilderStop(stop)}
                        aria-label={active ? `Remove ${stop.title}` : `Add ${stop.title}`}
                      >
                        <div className={styles.pickRouteArrow}>
                        <div className={styles.pickRouteIconCircle} aria-hidden="true">
                          {active ? (
                            <Image
                              src="/icons/x.svg"
                              alt=""
                              width={20}
                              height={20}
                              className={styles.pickRouteArrowIcon}
                              aria-hidden="true"
                            />
                          ) : (
                            <Image
                              src="/icons/plus.svg"
                              alt=""
                              width={20}
                              height={20}
                              className={styles.pickRouteArrowIcon}
                              aria-hidden="true"
                            />
                          )}
                        </div>
                        </div>
                      </button>
                    </div>
                  );
                })
              )}
            </div>

              {builderSelectedStops.length > 0 && (
                <div className={`${styles.pickDurationStartWrap} ${styles.buildMixStickyCtaWrap} ${styles.buildMixStickyCtaEnter}`}>
                  <button
                  onClick={() => {
                    if (isEditingStopsFromWalk) {
                      void saveEditedStopsFromWalk();
                      return;
                    }
                    if (!selectionValidation.ok) {
                      setErr(selectionValidation.message);
                      return;
                    }
                    setNarratorFlowSource("buildMix");
                    setPickDurationPage("narrator");
                    setStep("pickDuration");
                  }}
                  disabled={buildMixSubmitDisabled}
                  className={`${styles.landingCtaButton} ${styles.startTourButton}`}
                >
                  {isEditingStopsFromWalk ? "Save Tour" : "Continue"}
                </button>
              </div>
              )}
          </section>
          <section className={`${styles.pickImagePane} ${styles.buildMixImagePane}`}>
            <RouteMap
              stops={builderSelectedStops}
              currentStopIndex={0}
              myPos={myPos}
              cityCenter={selectedCityCenter}
              followCurrentStop={false}
              spreadOverlappingStops
            />
            <button
              onClick={closeRoutePicker}
              className={`${styles.mapBackButton} ${styles.mapBackButtonInverted} ${styles.pickCloseButtonMapMobile}`}
              aria-label="Close"
            >
              <Image
                src="/icons/x.svg"
                alt=""
                width={26}
                height={26}
                className={styles.mapBackIconDark}
                aria-hidden="true"
              />
            </button>
          </section>
        </main>
      )}

      {step === "followAlongSetup" && (
        <main className={`${styles.pickLayout} ${styles.followAlongLayout}`}>
          <section className={`${styles.pickInfo} ${styles.followAlongInfo}`}>
            <button
              onClick={goHome}
              className={`${styles.mapBackButton} ${styles.mapBackButtonInverted} ${styles.pickCloseButtonLeft} ${styles.pickCloseButtonDesktop}`}
              aria-label="Close"
            >
              <Image
                src="/icons/x.svg"
                alt=""
                width={26}
                height={26}
                className={styles.mapBackIconDark}
                aria-hidden="true"
              />
            </button>

            <div className={styles.pickCopyBlock}>
              <h2 className={styles.pickHeading}>Follow Along</h2>
              <p className={styles.followAlongLead}>
                Choose one destination. Wandrful will preload stories and surface them automatically as you drive.
              </p>
            </div>

            <div className={styles.followAlongFieldBlock}>
              <div className={styles.pickSectionLabel}>Starting point</div>
              <div className={styles.followAlongSummaryCard}>
                <div className={styles.pickRouteTitle}>
                  {followAlongOrigin?.label || "Current location required"}
                </div>
                <div className={styles.pickRouteMeta}>
                  {followAlongOrigin?.subtitle || "Allow location access to continue."}
                </div>
              </div>
            </div>

            <div className={styles.followAlongFieldBlock}>
              <div className={styles.pickSectionLabel}>Destination</div>
              <div className={styles.buildMixSearchRow}>
                <div className={styles.buildMixSearchInputWrap}>
                  <input
                    type="text"
                    value={followAlongDestinationQuery}
                    onChange={(e) => setFollowAlongDestinationQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" || isSearchingFollowAlongDestinations) return;
                      e.preventDefault();
                      void searchFollowAlongDestinations();
                    }}
                    className={styles.buildMixSearchInput}
                    placeholder="Search an address, landmark, or city"
                    aria-label="Search destination"
                  />
                  <div className={styles.buildMixSearchActions}>
                    {followAlongDestinationQuery.trim().length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setFollowAlongDestinationQuery("");
                          setFollowAlongDestinationResults([]);
                          setFollowAlongDestination(null);
                          setFollowAlongPreview(null);
                        }}
                        className={styles.buildMixSearchActionButton}
                        aria-label="Clear destination search"
                      >
                        <svg viewBox="0 0 24 24" className={styles.buildMixSearchClearIcon} aria-hidden="true">
                          <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                          <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void searchFollowAlongDestinations()}
                      disabled={isSearchingFollowAlongDestinations}
                      className={styles.buildMixSearchActionButton}
                      aria-label="Search destinations"
                    >
                      <svg viewBox="0 0 24 24" className={styles.buildMixSearchIcon} aria-hidden="true">
                        <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
                        <line x1="16.2" y1="16.2" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              {followAlongDestinationResults.length > 0 && (
                <div className={styles.buildMixSearchDropdown}>
                  {followAlongDestinationResults.map((candidate) => (
                    <button
                      key={`${candidate.placeId || candidate.label}-${candidate.lat}-${candidate.lng}`}
                      type="button"
                      className={styles.followAlongSearchRow}
                      onClick={() => {
                        setFollowAlongDestination(candidate);
                        setFollowAlongDestinationQuery(candidate.label);
                        setFollowAlongDestinationResults([]);
                        void previewFollowAlongRoute(candidate);
                      }}
                    >
                      <div>
                        <div className={styles.buildMixSearchDropdownTitle}>{candidate.label}</div>
                        <div className={styles.pickRouteMeta}>{candidate.subtitle || "Destination"}</div>
                      </div>
                      <div className={styles.pickRouteMetaSecondary}>Preview</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {followAlongPreview && (
              <div className={styles.followAlongSummaryCard}>
                <div className={styles.followAlongSummaryRow}>
                  <div>
                    <div className={styles.pickRouteTitle}>{followAlongPreview.destination.label}</div>
                    <div className={styles.pickRouteMeta}>
                      {followAlongPreview.destination.subtitle || "Destination selected"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void previewFollowAlongRoute()}
                    className={styles.pillButton}
                    disabled={isLoadingFollowAlongPreview}
                  >
                    Refresh
                  </button>
                </div>
                <div className={styles.followAlongStatsRow}>
                  <div className={styles.followAlongStat}>
                    <span className={styles.followAlongStatLabel}>Drive</span>
                    <span className={styles.followAlongStatValue}>
                      {formatDistance(followAlongPreview.distanceMeters)}
                    </span>
                  </div>
                  <div className={styles.followAlongStat}>
                    <span className={styles.followAlongStatLabel}>ETA</span>
                    <span className={styles.followAlongStatValue}>
                      {Math.max(1, Math.round(followAlongPreview.durationSeconds / 60))} min
                    </span>
                  </div>
                  <div className={styles.followAlongStat}>
                    <span className={styles.followAlongStatLabel}>Stories</span>
                    <span className={styles.followAlongStatValue}>
                      Auto
                    </span>
                  </div>
                </div>
                <div className={styles.pickRouteMeta}>{followAlongStatusCopy}</div>
              </div>
            )}

            <div className={styles.pickDurationStartWrap}>
              <button
                type="button"
                onClick={() => {
                  setErr(null);
                  setNarratorFlowSource("followAlong");
                  setPickDurationPage("narrator");
                  setStep("pickDuration");
                }}
                disabled={!followAlongPreview || !followAlongDestination || !followAlongOrigin || isLoadingFollowAlongPreview}
                className={`${styles.landingCtaButton} ${styles.startTourButton}`}
              >
                Continue
              </button>
            </div>
          </section>

          <section className={styles.pickImagePane}>
            <RouteMap
              stops={followAlongPreview ? [] : followAlongDestination ? [{ id: "follow-preview-destination", title: followAlongDestination.label, lat: followAlongDestination.lat, lng: followAlongDestination.lng, images: [DEFAULT_STOP_IMAGE], stopKind: "arrival" }] : []}
              currentStopIndex={-1}
              myPos={myPos}
              cityCenter={followAlongOrigin ?? selectedCityCenter}
              followCurrentStop={false}
              showRoutePath={Boolean(followAlongPreview)}
              routeCoords={followAlongPreview?.routeCoords ?? null}
              routeTravelMode="drive"
              endpoints={{
                origin: followAlongPreview?.origin ?? followAlongOrigin,
                destination: followAlongPreview?.destination ?? followAlongDestination,
              }}
            />
            <button
              onClick={goHome}
              className={`${styles.mapBackButton} ${styles.mapBackButtonInverted} ${styles.pickCloseButtonMapMobile}`}
              aria-label="Close"
            >
              <Image
                src="/icons/x.svg"
                alt=""
                width={26}
                height={26}
                className={styles.mapBackIconDark}
                aria-hidden="true"
              />
            </button>
          </section>
        </main>
      )}

      {step === "generating" && (
        <main className={styles.generatingLayout}>
          <Image
            src={generatingBackgroundImage}
            alt=""
            fill
            unoptimized
            className={styles.generatingImage}
            aria-hidden="true"
          />
          <div className={styles.generatingOverlay} aria-hidden="true" />
          <section className={styles.generatingPanel}>
            <div className={styles.generatingCopyBlock}>
              <h2 className={styles.generatingHeading}>Mixing your tour...</h2>
              
              <div className={styles.generationStatusWrap}>
                <div className={styles.generationStatusLine}>
                  <span>{generationStatusLabel}</span>
                  <span>{generationProgress}%</span>
                </div>
                <div className={styles.generationProgressBar}>
                  <div
                    className={styles.generationProgressFill}
                    style={{ width: `${generationProgress}%` }}
                  />
                </div>
                <div className={styles.generationStatusMessage}>{generationMessage}</div>
                {generationStatusLabel === "Failed" && (
                  <div className={styles.pickDurationStartWrap}>
                    <button
                      type="button"
                      onClick={() => {
                        if (generationJobKind === "preset") {
                          void startTourFromSelection();
                          return;
                        }
                        if (followAlongPreview && followAlongDestination && followAlongOrigin) {
                          void startFollowAlongExperience();
                          return;
                        }
                        void startCustomMixGeneration();
                      }}
                      disabled={isGeneratingMix || isCreatingFollowAlong}
                      className={styles.landingCtaButton}
                    >
                      Retry generation
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (generationJobKind === "preset") {
                          setNarratorFlowSource(null);
                          setStep("landing");
                          return;
                        }
                        if (followAlongPreview || followAlongDestination) {
                          setStep("followAlongSetup");
                          return;
                        }
                        setStep("buildMix");
                      }}
                      className={styles.pickBuildMixButton}
                    >
                      {generationJobKind === "preset" ? "Back to routes" : followAlongPreview || followAlongDestination ? "Back to route setup" : "Back to editor"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>
        </main>
      )}

      {step === "followAlongDrive" && route && (
        <main className={styles.walkLayout}>
          <div className={styles.mapHero}>
            <RouteMap
              stops={route.stops}
              currentStopIndex={currentStopIndex ?? -1}
              myPos={myPos}
              initialFitRoute
              followCurrentStop={false}
              showRoutePath
              routeCoords={route.routePathCoords ?? null}
              routeTravelMode="drive"
              endpoints={{
                origin: route.origin,
                destination: route.destination,
              }}
            />
            <button onClick={goHome} className={styles.mapBackButton} aria-label="Close">
              <Image
                src="/icons/x.svg"
                alt=""
                width={26}
                height={26}
                className={styles.mapBackIcon}
                aria-hidden="true"
              />
            </button>
            <a href={mapsUrl} target="_blank" rel="noreferrer" className={styles.mapViewButton}>
              Open Drive Route
            </a>
          </div>

          <div className={styles.rightRail}>
            <div className={styles.walkCard}>
              <div className={styles.walkMetaRow}>
                <div className={styles.walkNarratorAvatarWrap}>
                  {usesNarratorIcon(persona) ? (
                    <Image
                      src="/icons/stars.svg"
                      alt=""
                      width={22}
                      height={22}
                      className={styles.walkNarratorIcon}
                      aria-hidden="true"
                    />
                  ) : (
                    <Image
                      src={personaCatalog[persona].avatarSrc}
                      alt={personaCatalog[persona].avatarAlt}
                      fill
                      className={styles.walkNarratorAvatar}
                    />
                  )}
                </div>
                <div className={styles.walkNarrator}>
                  Follow Along by <span className={styles.walkNarratorActiveName}>{activePersonaDisplayName}</span>
                </div>
              </div>

              <h1 className={styles.walkHeadline}>{route.title}</h1>
              <div className={styles.walkSubline}>
                <span>
                  {route.transportMode === "drive" ? "Drive" : "Walk"} • {route.durationLabel} / {routeMilesLabel}
                </span>
              </div>

              <div className={styles.followAlongSummaryCard}>
                <div className={styles.followAlongSummaryRow}>
                  <div>
                    <div className={styles.pickRouteTitle}>
                      {route.destination?.label || route.stops[route.stops.length - 1]?.title}
                    </div>
                    <div className={styles.pickRouteMeta}>
                      {followAlongOffRoute
                        ? "Off route. Rejoin the planned route to resume automatic stories."
                        : followAlongStatusCopy}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={styles.nowPlayingButton}
                    onClick={toggleAudio}
                    disabled={currentStopIndex === null || !hasCurrentAudio}
                    aria-label={isPlaying ? "Pause current story" : "Play current story"}
                  >
                    <Image
                      src={isPlaying ? "/icons/pause-fill.svg" : "/icons/play-fill.svg"}
                      alt=""
                      width={28}
                      height={28}
                      className={styles.nowPlayingIcon}
                      aria-hidden="true"
                    />
                  </button>
                </div>
                <div className={styles.followAlongStatsRow}>
                  <div className={styles.followAlongStat}>
                    <span className={styles.followAlongStatLabel}>Progress</span>
                    <span className={styles.followAlongStatValue}>
                      {followAlongRouteProgressM !== null ? formatDistance(followAlongRouteProgressM) : "Waiting"}
                    </span>
                  </div>
                  <div className={styles.followAlongStat}>
                    <span className={styles.followAlongStatLabel}>Next trigger</span>
                    <span className={styles.followAlongStatValue}>
                      {distanceToStopM !== null ? formatDistance(distanceToStopM) : "Auto"}
                    </span>
                  </div>
                  <div className={styles.followAlongStat}>
                    <span className={styles.followAlongStatLabel}>Background</span>
                    <span className={styles.followAlongStatValue}>Keep screen active</span>
                  </div>
                </div>
              </div>

              {currentStop ? (
                <div className={styles.followAlongStoryCard}>
                  <div className={styles.followAlongStoryImageWrap}>
                    <Image
                      src={toSafeStopImage(currentStop.images[0])}
                      alt={currentStop.title}
                      fill
                      className={styles.scriptModalImage}
                      unoptimized
                    />
                  </div>
                  <div className={styles.followAlongStoryBody}>
                    <div className={styles.followAlongStoryEyebrow}>
                      {currentStop.stopKind === "arrival" ? "Arrival story" : "Now playing"}
                    </div>
                    <button
                      type="button"
                      className={styles.nowPlayingTitleLink}
                      onClick={openScriptModal}
                    >
                      {currentStop.title}
                      <Image
                        src="/icons/file-earmark-text.svg"
                        alt=""
                        width={14}
                        height={14}
                        className={styles.nowPlayingTitleLinkIcon}
                        aria-hidden="true"
                      />
                    </button>
                    <div className={styles.pickRouteMeta}>
                      {hasCurrentAudio
                        ? `${formatAudioTime(audioTime)} / ${formatAudioTime(audioDuration)}`
                        : "Audio is loading for this story."}
                    </div>
                  </div>
                </div>
              ) : (
                <div className={styles.followAlongSummaryCard}>
                  <div className={styles.pickRouteTitle}>Stories will appear automatically</div>
                  <div className={styles.pickRouteMeta}>
                    Keep the page visible while driving. When you near a route story, the card and audio will open automatically.
                  </div>
                </div>
              )}
            </div>

            {currentStop && (
              <div className={styles.nowPlayingBar}>
                <audio ref={audioRef} preload="none" src={hasCurrentAudio ? currentStopAudio : undefined} hidden />
                <input
                  type="range"
                  min={0}
                  max={audioDuration || 0}
                  step={0.1}
                  value={Math.min(audioTime, audioDuration || audioTime)}
                  onChange={(e) => seekAudio(Number(e.target.value))}
                  disabled={!hasCurrentAudio}
                  className={`${styles.audioSeek} ${styles.nowPlayingSeek}`}
                />
                <div className={`${styles.nowPlayingContent} ${styles.nowPlayingContentEnter}`}>
                  <div className={styles.nowPlayingMetaGroup}>
                    <button
                      type="button"
                      className={styles.nowPlayingMetaButton}
                      onClick={openScriptModal}
                    >
                      <div className={styles.nowPlayingThumbWrap}>
                        <Image
                          src={toSafeStopImage(currentStop.images[0])}
                          alt={currentStop.title}
                          fill
                          className={styles.nowPlayingThumb}
                          unoptimized
                        />
                      </div>
                      <div className={styles.nowPlayingMeta}>
                        <div className={styles.nowPlayingTitleText}>{currentStop.title}</div>
                        <div className={styles.nowPlayingSubtitle}>
                          {hasCurrentAudio
                            ? `${formatAudioTime(audioTime)} / ${formatAudioTime(audioDuration)}`
                            : "Audio not generated yet"}
                        </div>
                      </div>
                    </button>
                  </div>
                  <button
                    className={`${styles.nowPlayingButton} ${styles.nowPlayingBarButton}`}
                    onClick={toggleAudio}
                    disabled={!hasCurrentAudio}
                    aria-label={isPlaying ? "Pause current story" : "Play current story"}
                  >
                    <Image
                      src={isPlaying ? "/icons/pause-fill.svg" : "/icons/play-fill.svg"}
                      alt=""
                      width={28}
                      height={28}
                      className={`${styles.nowPlayingIcon} ${styles.nowPlayingBarIcon}`}
                      aria-hidden="true"
                    />
                  </button>
                </div>
              </div>
            )}
            {(isScriptModalOpen || isScriptModalClosing) && currentStop && (
              <div
                className={`${styles.scriptModalOverlay} ${isScriptModalClosing ? styles.scriptModalOverlayClosing : ""}`}
                role="dialog"
                aria-modal="true"
                aria-label="Narration script"
              >
                <div className={`${styles.scriptModal} ${isScriptModalClosing ? styles.scriptModalClosing : ""}`}>
                  <button
                    type="button"
                    className={styles.scriptModalClose}
                    onClick={closeScriptModal}
                    aria-label="Close script"
                  >
                    <Image
                      src="/icons/x.svg"
                      alt=""
                      width={16}
                      height={16}
                      className={styles.scriptModalCloseIcon}
                      aria-hidden="true"
                    />
                  </button>
                  <div className={styles.scriptModalImageWrap}>
                    <Image
                      src={toSafeStopImage(currentStop.images[0])}
                      alt={currentStop.title}
                      fill
                      className={styles.scriptModalImage}
                      unoptimized
                    />
                  </div>
                  <div className={styles.scriptModalBody}>
                    {currentStopScript || (isGeneratingScriptForModal ? "Generating script..." : "No generated script for this stop yet.")}
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      )}

      {/* WALK */}
      {step === "walk" && route && (
        <main className={styles.walkLayout}>
          <div className={styles.mapHero}>
            <RouteMap
              stops={route.stops}
              currentStopIndex={currentStopIndex ?? -1}
              myPos={myPos}
              initialFitRoute
              showRoutePath
              routeTravelMode="walk"
            />
            <button onClick={goHome} className={styles.mapBackButton} aria-label="Close">
              <Image
                src="/icons/x.svg"
                alt=""
                width={26}
                height={26}
                className={styles.mapBackIcon}
                aria-hidden="true"
              />
            </button>
            <a href={mapsUrl} target="_blank" rel="noreferrer" className={styles.mapViewButton}>
              View Directions
            </a>
          </div>
          <div className={styles.rightRail}>
            <div className={styles.walkCard}>
              <div className={styles.walkMetaRow}>
                {isPresetWalkRoute ? (
                  <>
                    <div className={styles.walkNarratorAvatarWrap}>
                      {usesNarratorIcon(persona) ? (
                        <Image
                          src="/icons/stars.svg"
                          alt=""
                          width={22}
                          height={22}
                          className={styles.walkNarratorIcon}
                          aria-hidden="true"
                        />
                      ) : (
                        <Image
                          src={personaCatalog[persona].avatarSrc}
                          alt={personaCatalog[persona].avatarAlt}
                          fill
                          className={styles.walkNarratorAvatar}
                        />
                      )}
                    </div>
                    <div className={styles.walkNarrator}>
                      Story by <span className={styles.walkNarratorActiveName}>{activePersonaDisplayName}</span>
                    </div>
                  </>
                ) : (
                  <>
                    {isInstagramAttributedCustomRoute ? (
                      <>
                        {instagramStoryByUrl ? (
                          <a
                            href={instagramStoryByUrl}
                            target="_blank"
                            rel="noreferrer"
                            className={styles.walkNarratorAvatarWrap}
                            aria-label={`Open ${instagramStoryByLabel} on Instagram`}
                          >
                            {instagramStoryByAvatarUrl ? (
                              <Image
                                src={instagramStoryByAvatarUrl}
                                alt={`${instagramStoryByLabel} avatar`}
                                fill
                                className={styles.walkNarratorAvatar}
                              />
                            ) : (
                              <Image
                                src="/icons/stars.svg"
                                alt=""
                                width={22}
                                height={22}
                                className={styles.walkNarratorIcon}
                                aria-hidden="true"
                              />
                            )}
                          </a>
                        ) : (
                          <div className={styles.walkNarratorAvatarWrap}>
                            {instagramStoryByAvatarUrl ? (
                              <Image
                                src={instagramStoryByAvatarUrl}
                                alt={`${instagramStoryByLabel} avatar`}
                                fill
                                className={styles.walkNarratorAvatar}
                              />
                            ) : (
                              <Image
                                src="/icons/stars.svg"
                                alt=""
                                width={22}
                                height={22}
                                className={styles.walkNarratorIcon}
                                aria-hidden="true"
                              />
                            )}
                          </div>
                        )}
                        <div className={styles.walkNarrator}>
                          Story by{" "}
                          {instagramStoryByUrl ? (
                            <a
                              href={instagramStoryByUrl}
                              target="_blank"
                              rel="noreferrer"
                              className={styles.walkNarratorActiveName}
                            >
                              {instagramStoryByLabel}
                            </a>
                          ) : (
                            <span className={styles.walkNarratorActiveName}>{instagramStoryByLabel}</span>
                          )}
                          <span className={styles.walkNarratorRemixPill}>AI Remix</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={`${styles.walkNarratorAvatarWrap} ${styles.walkNarratorAvatarButton}`}
                          onClick={() => {
                            setReturnToWalkOnClose(true);
                            setNarratorFlowSource("walkEdit");
                            setPickDurationPage("narrator");
                            setStep("pickDuration");
                          }}
                          aria-label="Edit narrator"
                        >
                          {usesNarratorIcon(persona) ? (
                            <Image
                              src="/icons/stars.svg"
                              alt=""
                              width={22}
                              height={22}
                              className={styles.walkNarratorIcon}
                              aria-hidden="true"
                            />
                          ) : (
                            <Image
                              src={personaCatalog[persona].avatarSrc}
                              alt={personaCatalog[persona].avatarAlt}
                              fill
                              className={styles.walkNarratorAvatar}
                            />
                          )}
                        </button>
                        <button
                          className={`${styles.walkNarrator} ${styles.walkNarratorButton}`}
                          type="button"
                          onClick={() => {
                            setReturnToWalkOnClose(true);
                            setNarratorFlowSource("walkEdit");
                            setPickDurationPage("narrator");
                            setStep("pickDuration");
                          }}
                        >
                          Narrated by <span className={styles.walkNarratorActiveName}>{activePersonaDisplayName}</span>
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            <h1 className={styles.walkHeadline}>{route.title}</h1>
              <div className={styles.walkSubline}>
                <span>{displayListenerCount} {displayListenerCount === 1 ? "listener" : "listeners"}  •  {routeMilesLabel}</span>
              </div>

              <div className={styles.walkActionRow}>
                <button className={styles.pillButton} type="button" onClick={copyShareLink}>Share</button>

                {activePresetWalkRouteId && (
                  <button
                    className={styles.pillButton}
                    type="button"
                    onClick={() => {
                      void regeneratePresetRoute(activePresetWalkRouteId);
                    }}
                    disabled={isActivePresetWalkRegenerating}
                    aria-label={`Regenerate ${route.title} with latest guidance`}
                  >
                    {isActivePresetWalkRegenerating ? "Regenerating..." : "Regenerate"}
                  </button>
                )}

                <button
                  className={styles.pillButton}
                  type="button"
                  onClick={openEditStopsFromWalk}
                >
                  Edit
                </button>
                <button
                  className={styles.nowPlayingButton}
                  type="button"
                  onClick={() => void playPauseFromWalkAction()}
                  disabled={route.stops.length === 0 || (currentStopIndex !== null && !hasCurrentAudio)}
                  aria-label={isPlaying ? "Pause current stop" : "Play current stop"}
                >
                  <Image
                    src={isPlaying ? "/icons/pause-fill.svg" : "/icons/play-fill.svg"}
                    alt=""
                    width={28}
                    height={28}
                    className={styles.nowPlayingIcon}
                    aria-hidden="true"
                  />
                </button>
              </div>

              <div className={styles.stopList}>
                {stopList.map((stop, idx) => {
                  const displayNumber = idx + 1;
                  return (
                  <button
                    key={stop.id}
                    onClick={() => void handleStopSelect(idx)}
                    className={`${styles.stopItem} ${stop.isActive ? styles.stopItemActive : ""}`}
                    type="button"
                  >
                    <div className={styles.stopThumbWrap}>
                      <Image
                        src={toSafeStopImage(stop.image)}
                        alt={stop.title}
                        fill
                        className={styles.stopThumb}
                        unoptimized
                      />
                    </div>
                    <div className={styles.stopText}>
                      <div className={`${styles.stopTitle} ${stop.isActive ? styles.stopTitleActive : ""}`}>
                        {`${displayNumber}. ${stop.title}`}
                      </div>
                      <div className={styles.stopSubtitle}>{stop.subtitle}</div>
                    </div>
                  </button>
                  );
                })}
              </div>

              <div className={styles.pickDurationStartWrap}>
                <button
                  type="button"
                  className={styles.walkFindMoreButton}
                  onClick={() => void handleFindMoreAroundLocation()}
                  disabled={isSurpriseMixDisabled}
                >
                  <span className={styles.walkFindMoreIconCircle} aria-hidden="true">
                    <Image
                      src="/icons/plus.svg"
                      alt=""
                      width={20}
                      height={20}
                      className={styles.walkFindMoreIcon}
                      aria-hidden="true"
                    />
                  </span>
                  <span className={styles.walkFindMoreLabel}>
                    {isResolvingNearbyGeo
                      ? "Locating you..."
                      : isGeneratingNearbyStory
                        ? "Finding nearby stops..."
                        : isSurpriseMixUnavailable
                          ? "Add more stops near you (coming soon)"
                          : "Add more stops near you"}
                  </span>
                </button>
              </div>
              
            </div>

            {currentStop && (
              <div className={styles.nowPlayingBar}>
                <audio ref={audioRef} preload="none" src={hasCurrentAudio ? currentStopAudio : undefined} hidden />
                <input
                  type="range"
                  min={0}
                  max={audioDuration || 0}
                  step={0.1}
                  value={Math.min(audioTime, audioDuration || audioTime)}
                  onChange={(e) => seekAudio(Number(e.target.value))}
                  disabled={!hasCurrentAudio}
                  className={`${styles.audioSeek} ${styles.nowPlayingSeek}`}
                />
                <div className={`${styles.nowPlayingContent} ${styles.nowPlayingContentEnter}`}>
                  <div className={styles.nowPlayingMetaGroup}>
                    <button
                      type="button"
                      className={styles.nowPlayingMetaButton}
                      onClick={openScriptModal}
                    >
                      <div className={styles.nowPlayingThumbWrap}>
                        <Image
                          src={toSafeStopImage(currentStop.images[0])}
                          alt={currentStop.title}
                          fill
                          className={styles.nowPlayingThumb}
                          unoptimized
                        />
                      </div>
                      <div className={styles.nowPlayingMeta}>
                        <div className={styles.nowPlayingTitleText}>{currentStop.title}</div>
                        <div className={styles.nowPlayingSubtitle}>
                          {isGeneratingScriptForModal
                            ? "Generating script..."
                            : isGeneratingAudioForCurrentStop
                              ? "Generating audio..."
                              : hasCurrentAudio
                                ? `${formatAudioTime(audioTime)} / ${formatAudioTime(audioDuration)}`
                                : "Audio not generated yet"}
                        </div>
                      </div>
                    </button>
                    {hasCurrentAudio ? (
                      <a
                        className={styles.nowPlayingInlineLink}
                        href={currentStopAudio}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View audio
                      </a>
                    ) : null}
                  </div>
                  <button
                    className={`${styles.nowPlayingButton} ${styles.nowPlayingBarButton}`}
                    onClick={toggleAudio}
                    disabled={!hasCurrentAudio}
                    aria-label={isPlaying ? "Pause current stop" : "Play current stop"}
                  >
                    <Image
                      src={isPlaying ? "/icons/pause-fill.svg" : "/icons/play-fill.svg"}
                      alt=""
                      width={28}
                      height={28}
                      className={`${styles.nowPlayingIcon} ${styles.nowPlayingBarIcon}`}
                      aria-hidden="true"
                    />
                  </button>
                </div>
              </div>
            )}
            {(isScriptModalOpen || isScriptModalClosing) && currentStop && (
              <div
                className={`${styles.scriptModalOverlay} ${isScriptModalClosing ? styles.scriptModalOverlayClosing : ""}`}
                role="dialog"
                aria-modal="true"
                aria-label="Narration script"
              >
                <div className={`${styles.scriptModal} ${isScriptModalClosing ? styles.scriptModalClosing : ""}`}>
                  <button
                    type="button"
                    className={styles.scriptModalClose}
                    onClick={closeScriptModal}
                    aria-label="Close script"
                  >
                    <Image
                      src="/icons/x.svg"
                      alt=""
                      width={16}
                      height={16}
                      className={styles.scriptModalCloseIcon}
                      aria-hidden="true"
                    />
                  </button>
                  <div className={styles.scriptModalImageWrap}>
                    <Image
                      src={toSafeStopImage(currentStop.images[0])}
                      alt={currentStop.title}
                      fill
                      className={styles.scriptModalImage}
                      unoptimized
                    />
                  </div>
                  <div className={styles.scriptModalBody}>
                    {currentStopScript || (isGeneratingScriptForModal ? "Generating script..." : "No generated script for this stop yet.")}
                  </div>
                </div>
              </div>
            )}
          </div>

          
        </main>
        
      )}

      {/* END */}
      {step === "end" && route && (
        <main className={styles.section}>
          <h2 className={styles.walkTitle}>Nice work — walk complete.</h2>
          <p className={styles.endText}>
            Reflection prompt (MVP): What was one detail you didn’t expect?
          </p>
          <p className={`${styles.endText} ${styles.lightMuted} ${styles.spacedTop}`}>
            Some stop photos are provided by{" "}
            <a href="https://www.pexels.com/" target="_blank" rel="noreferrer">
              Pexels
            </a>
            .
          </p>

          <div className={styles.actionRow}>
            <button onClick={() => restartWalk()} className={`${styles.button} ${styles.buttonLarge}`}>
              Restart this walk
            </button>
            <button
              onClick={copyShareLink}
              className={`${styles.button} ${styles.buttonLarge}`}
            >
              Copy share link
            </button>
            <button
              onClick={() => {
                router.replace("/");
                setJam(null);
                setStep("landing");
              }}
              className={`${styles.button} ${styles.buttonLarge}`}
            >
              Start over
            </button>
          </div>
        </main>

      )}

     {/* footer Jam 
     {step !== "walk" && step !== "landing" && step !== "pickDuration" && (
        <footer className={styles.footer}>
          {jam ? `Jam: ${jam.id}` : "No jam loaded"}
        </footer>
      )}
      */}
    </div>
  );
}

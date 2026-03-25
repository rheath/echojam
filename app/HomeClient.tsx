"use client";
 
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image, { type ImageProps } from "next/image";
import { supabase } from "@/lib/supabaseClient";
import {
  getPresetRouteSummariesByCity,
  getPresetRouteSummaryById,
  getPresetRouteSummaryImage,
  getPresetRouteSummaryNarratorLabel,
  getPresetRouteSummaryStopCount,
} from "@/app/content/presetRouteSummaries";
import type { Persona, PresetCity, PresetRouteSummary, RouteDef, RoutePricing } from "@/app/content/routeTypes";
import { getPresetCityMeta, isPresetOverviewStopId } from "@/lib/presetOverview";
import { personaCatalog } from "@/lib/personas/catalog";
import { getMaxStops, validateMixSelection } from "@/lib/mixConstraints";
import { CUSTOM_NARRATOR_MAX_CHARS } from "@/lib/customNarrator";
import {
  nextFollowAlongStopIndex,
  normalizeRouteProgress,
  shouldTriggerFollowAlongStop,
  type FollowAlongLocation,
} from "@/lib/followAlong";
import {
  appendWalkDiscoveryPosition,
  buildWalkDiscoveryCandidateKey,
  pruneWalkDiscoveryCooldowns,
  shouldExpireWalkDiscoverySuggestion,
  type WalkDiscoveryPositionSample,
  type WalkDiscoverySuggestion,
  WALK_DISCOVERY_COOLDOWN_MS,
  WALK_DISCOVERY_FETCH_MIN_MOVE_METERS,
  WALK_DISCOVERY_MIN_DISTANCE_FROM_ACCEPTED_METERS,
} from "@/lib/walkDiscovery";
import {
  createJamPerfTracker,
  isJamDocumentVisible,
  shouldCommitGeoUpdate,
  shouldRunJamGeoTracking,
  shouldRunWalkDiscoveryWork,
  type GeoCommitSample,
  type JamVisibilityState,
} from "@/lib/jamRuntime";
import { buildGoogleMapsDirectionsUrl } from "@/lib/routePath";
import dynamic from "next/dynamic";
import WalkScreen from "./components/WalkScreen";
import walkStyles from "./components/WalkScreen.module.css";
import styles from "./HomeClient.module.css";

const RouteMap = dynamic(() => import("./components/RouteMap"), { ssr: false });
const SCRIPT_MODAL_EXIT_MS = 240;


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

function isCustomNarratorFlowSource(
  narratorFlowSource: NarratorFlowSource,
  isPresetWalkRoute: boolean
) {
  return (
    narratorFlowSource === "followAlong" ||
    narratorFlowSource === "buildMix" ||
    (narratorFlowSource === "walkEdit" && !isPresetWalkRoute)
  );
}

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
    experience_kind?: "mix" | "follow_along" | "walk_discovery" | null;
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
    story_by_source?: "instagram" | "tiktok" | "social" | null;
  };
  stops: Array<{
    stop_id: string;
    title: string;
    lat: number;
    lng: number;
    image_url: string | null;
    source_provider?: "instagram" | "tiktok" | "google_places" | null;
    source_kind?: "social_import" | "place_search" | null;
    source_url?: string | null;
    source_id?: string | null;
    source_creator_name?: string | null;
    source_creator_url?: string | null;
    source_creator_avatar_url?: string | null;
    google_place_id?: string | null;
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

function formatStopSourceLabel(stop: Pick<RouteDef["stops"][number], "sourceProvider" | "sourceCreatorName"> | null | undefined) {
  if (!stop?.sourceProvider) return null;
  if (stop.sourceProvider === "google_places") return "Google Place";
  const creator = (stop.sourceCreatorName || "").trim();
  if (stop.sourceProvider === "instagram") {
    return creator ? `Instagram • ${creator}` : "Instagram";
  }
  return creator ? `TikTok • ${creator}` : "TikTok";
}

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

type WalkDiscoveryStartResponse = {
  jamId: string;
  routeId: string;
  routeRef: string;
  insertedStopId: string;
  insertedStopIndex: number;
  source: string;
  distanceMeters: number | null;
  startupSuggestionKey: string;
};

type WalkDiscoverySuggestResponse = {
  suggestion: WalkDiscoverySuggestion | null;
};

type WalkDiscoveryAcceptResponse = {
  jamId: string;
  routeId: string;
  routeRef: string;
  insertedStopId: string;
  insertedStopIndex: number;
  source: string;
  distanceMeters: number | null;
};

type WalkDiscoveryCheckoutSessionResponse = {
  url: string | null;
  sessionId: string;
};

type PendingWalkDiscoveryCheckout = {
  jamId: string;
  suggestion: WalkDiscoverySuggestion;
};

type StartCustomMixOptions = {
  source?: "manual" | "instant";
  routeTitle?: string;
  errorStep?: FlowStep;
  cityOverride?: string;
  narratorGuidance?: string | null;
  experienceKind?: "mix" | "walk_discovery";
};

type StartPresetTourOptions = {
  forceRegenerateAll?: boolean;
  allowPaidStart?: boolean;
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
const BACKGROUND_GENERATION_TIMEOUT_MS = 120000;
const FOLLOW_ALONG_ORIGIN_PENDING_SUBTITLE = "Finding address...";
const FOLLOW_ALONG_ORIGIN_FALLBACK_SUBTITLE = "Location detected";
const PERSONA_KEYS: Array<Exclude<Persona, "custom">> = ["adult", "preteen", "ghost"];
const DEFAULT_STOP_IMAGE = "/images/salem/placeholder.png";
const LANDING_VIDEO_MAX_PLAYS = 4;
const WALK_DISCOVERY_STORAGE_PREFIX = "wandrful-walk-discovery";
const WALK_DISCOVERY_CHECKOUT_STORAGE_PREFIX = `${WALK_DISCOVERY_STORAGE_PREFIX}:checkout`;
const DISTANCE_TO_STOP_EPSILON_METERS = 5;
const FOLLOW_ALONG_PROGRESS_EPSILON_METERS = 20;
const MAGIC_LINK_SUCCESS_MESSAGE =
  "Check your inbox for a private Wandrful sign-in link from Wandrful Support. It expires in 5 minutes.";
const CITY_META: Record<CityOption, { label: string; center: { lat: number; lng: number } }> = {
  salem: { label: "Salem", center: { lat: 42.5195, lng: -70.8967 } },
  boston: { label: "Boston", center: { lat: 42.3601, lng: -71.0589 } },
  concord: { label: "Concord", center: { lat: 42.4604, lng: -71.3489 } },
  nyc: { label: "New York City", center: { lat: 40.7527, lng: -73.9772 } },
};
const FEATURED_PRESET_SECTIONS = [
  {
    title: "Time Travel Journeys",
    routeIds: [
      "boston-revolutionary-secrets",
      "boston-old-taverns",
      "nyc-architecture-walk",
      "salem-after-dark",
    ] as const satisfies readonly RouteDef["id"][],
  },
  {
    title: "City Adventure Journeys",
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
const TRUTHY_FLAG_VALUES = ["1", "true", "yes", "on"];

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
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

type WalkStepImageProps = Omit<ImageProps, "src" | "alt"> & {
  src: string | null | undefined;
  alt: string;
};

function WalkStepImage({ src, alt, onError, ...props }: WalkStepImageProps) {
  const safeSrc = toSafeStopImage(src);
  const [resolvedSrc, setResolvedSrc] = useState(safeSrc);

  useEffect(() => {
    setResolvedSrc(safeSrc);
  }, [safeSrc]);

  return (
    <Image
      {...props}
      src={resolvedSrc}
      alt={alt}
      onError={(event) => {
        if (resolvedSrc !== DEFAULT_STOP_IMAGE) {
          setResolvedSrc(DEFAULT_STOP_IMAGE);
        }
        onError?.(event);
      }}
    />
  );
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

function getRouteNarratorLabel(
  route: Pick<RouteDef, "storyBy"> | Pick<PresetRouteSummary, "storyBy"> | null | undefined,
  persona: Persona
) {
  const override = typeof route?.storyBy === "string" ? route.storyBy.trim() : "";
  if (override) return override;
  return personaCatalog[persona].displayName;
}

function getPresetRouteNarratorLabel(route: Pick<PresetRouteSummary, "storyBy" | "defaultPersona">) {
  return getPresetRouteSummaryNarratorLabel(route);
}

function getPresetRouteIcon() {
  return "/icons/stars.svg";
}

function getLandingTitleFontClass(routeId: string) {
  if (routeId === "boston-revolutionary-secrets") return styles.landingTitleFontRevolutionary;
  if (routeId === "boston-old-taverns") return styles.landingTitleFontTaverns;
  if (routeId === "nyc-architecture-walk") return styles.landingTitleFontArchitecture;
  if (routeId === "salem-after-dark") return styles.landingTitleFontSalem;
  if (routeId === "nyc-city-animals-adventure") return styles.landingTitleFontAnimals;
  if (routeId === "nyc-superhero-city") return styles.landingTitleFontSuperhero;
  if (routeId === "nyc-weird-wacky-history") return styles.landingTitleFontWeirdHistory;
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

function getLandingRouteImage(route: PresetRouteSummary) {
  return getPresetRouteSummaryImage(route);
}

function toKnownCityOption(value: string | null | undefined): PresetCity | undefined {
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

function buildRouteStopCandidateKey(stop: {
  title: string;
  lat: number;
  lng: number;
  googlePlaceId?: string | null;
}) {
  return buildWalkDiscoveryCandidateKey({
    title: stop.title,
    lat: stop.lat,
    lng: stop.lng,
    googlePlaceId: stop.googlePlaceId ?? undefined,
  });
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

async function withSupabaseAuthHeaders(headersInit?: HeadersInit) {
  const headers = new Headers(headersInit);
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token?.trim();
  if (accessToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  return headers;
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

function getWalkDiscoveryStorageKey(jamId: string) {
  return `${WALK_DISCOVERY_STORAGE_PREFIX}:${jamId}`;
}

function loadWalkDiscoveryCooldowns(jamId: string) {
  if (typeof window === "undefined") return {} as Record<string, number>;
  try {
    const raw = window.localStorage.getItem(getWalkDiscoveryStorageKey(jamId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        numeric[key] = value;
      }
    }
    return pruneWalkDiscoveryCooldowns(numeric);
  } catch {
    return {};
  }
}

function saveWalkDiscoveryCooldowns(jamId: string, cooldowns: Record<string, number>) {
  if (typeof window === "undefined") return;
  try {
    const pruned = pruneWalkDiscoveryCooldowns(cooldowns);
    window.localStorage.setItem(
      getWalkDiscoveryStorageKey(jamId),
      JSON.stringify(pruned)
    );
  } catch {
    // Ignore localStorage failures; discovery still works in-memory.
  }
}

function getWalkDiscoveryCheckoutStorageKey(jamId: string, purchaseKey: string) {
  return `${WALK_DISCOVERY_CHECKOUT_STORAGE_PREFIX}:${jamId}:${purchaseKey}`;
}

function loadPendingWalkDiscoveryCheckout(jamId: string, purchaseKey: string) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(
      getWalkDiscoveryCheckoutStorageKey(jamId, purchaseKey)
    );
    if (!raw) return null;
    return JSON.parse(raw) as PendingWalkDiscoveryCheckout;
  } catch {
    return null;
  }
}

function savePendingWalkDiscoveryCheckout(payload: PendingWalkDiscoveryCheckout) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      getWalkDiscoveryCheckoutStorageKey(payload.jamId, payload.suggestion.purchaseKey),
      JSON.stringify(payload)
    );
  } catch {
    // Ignore localStorage failures and continue to hosted checkout.
  }
}

function clearPendingWalkDiscoveryCheckout(jamId: string, purchaseKey: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(
      getWalkDiscoveryCheckoutStorageKey(jamId, purchaseKey)
    );
  } catch {
    // Ignore localStorage failures.
  }
}

function hasMeaningfulNumberChange(
  previous: number | null,
  next: number | null,
  epsilon: number
) {
  if (previous === null || next === null) return previous !== next;
  return Math.abs(previous - next) >= epsilon;
}

export default function HomeClient() {
  const [distanceToStopM, setDistanceToStopM] = useState<number | null>(null);
  const [proximity, setProximity] = useState<"far" | "near" | "arrived">("far");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [listenCount, setListenCount] = useState(0);
  const [isLandingJourneyModalOpen, setIsLandingJourneyModalOpen] = useState(false);
  const [selectedRouteId, setSelectedRouteId] = useState<RouteDef["id"] | null>(null);
  const [isCreateOwnSelected, setIsCreateOwnSelected] = useState(false);
  const [selectedPersona, setSelectedPersona] = useState<Persona | null>(null);
  const [customNarratorGuidance, setCustomNarratorGuidance] = useState("");
  const [pickDurationPage, setPickDurationPage] = useState<PickDurationPage>("routes");
  const [narratorFlowSource, setNarratorFlowSource] = useState<NarratorFlowSource>(null);
  const [selectedCity, setSelectedCity] = useState<CityOption>("salem");
  const [instantDiscoveryCity, setInstantDiscoveryCity] = useState<string | null>(null);
  const [builderSelectedStops, setBuilderSelectedStops] = useState<CustomMixStop[]>([]);
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
  const [customRoute, setCustomRoute] = useState<RouteDef | null>(null);
  const [didInstagramAvatarFail, setDidInstagramAvatarFail] = useState(false);
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
  const [isStartingWalkDiscovery, setIsStartingWalkDiscovery] = useState(false);
  const [walkDiscoverySuggestion, setWalkDiscoverySuggestion] = useState<WalkDiscoverySuggestion | null>(null);
  const [walkDiscoveryCheckoutSuggestion, setWalkDiscoveryCheckoutSuggestion] = useState<WalkDiscoverySuggestion | null>(null);
  const [isResolvingWalkDiscoverySuggestion, setIsResolvingWalkDiscoverySuggestion] = useState(false);
  const [isAcceptingWalkDiscoverySuggestion, setIsAcceptingWalkDiscoverySuggestion] = useState(false);
  const [isStartingWalkDiscoveryCheckout, setIsStartingWalkDiscoveryCheckout] = useState(false);
  const [isCompletingWalkDiscoveryCheckout, setIsCompletingWalkDiscoveryCheckout] = useState(false);
  const [walkDiscoveryMagicLinkEmail, setWalkDiscoveryMagicLinkEmail] = useState("");
  const [walkDiscoveryMagicLinkMessage, setWalkDiscoveryMagicLinkMessage] = useState<string | null>(null);
  const [isSendingWalkDiscoveryMagicLink, setIsSendingWalkDiscoveryMagicLink] = useState(false);
  const [isGeneratingWalkDiscoveryAcceptedStopAssets, setIsGeneratingWalkDiscoveryAcceptedStopAssets] = useState(false);
  const [returnToWalkOnClose, setReturnToWalkOnClose] = useState(false);
  const [isEditingStopsFromWalk, setIsEditingStopsFromWalk] = useState(false);
  const [activeStopIndex, setActiveStopIndex] = useState<number | null>(null);
  const [pendingAutoplayStopId, setPendingAutoplayStopId] = useState<string | null>(null);
  const jamCurrentStopRef = useRef<number | null>(null);
  const previousStepRef = useRef<FlowStep>("landing");
  const scriptModalCloseTimeoutRef = useRef<number | null>(null);
  const followAlongSessionRef = useRef(0);
  const landingVideoRef = useRef<HTMLVideoElement | null>(null);
  const followAlongLastPositionRef = useRef<{
    lat: number;
    lng: number;
    timestamp: number;
  } | null>(null);
  const walkDiscoveryRecentPositionsRef = useRef<WalkDiscoveryPositionSample[]>([]);
  const walkDiscoveryLastFetchPosRef = useRef<{ lat: number; lng: number } | null>(null);
  const walkDiscoveryCooldownsRef = useRef<Record<string, number>>({});
  const walkDiscoveryRequestIdRef = useRef(0);
  const perfTrackerRef = useRef(createJamPerfTracker());
  const lastCommittedGeoRef = useRef<GeoCommitSample | null>(null);
  const latestRawGeoRef = useRef<GeoCommitSample | null>(null);
  const lastDistanceToStopMRef = useRef<number | null>(null);
  const lastProximityRef = useRef<"far" | "near" | "arrived">("far");
  const lastFollowAlongRouteProgressMRef = useRef<number | null>(null);
  const lastFollowAlongOffRouteRef = useRef(false);
  const previousVisibilityRef = useRef<JamVisibilityState>("visible");

  const router = useRouter();
  const searchParams = useSearchParams();

  const [err, setErr] = useState<string | null>(null);
  const [jam, setJam] = useState<JamRow | null>(null);
  const [authUserEmail, setAuthUserEmail] = useState<string | null>(null);
  const countedJamOpenRef = useRef<Set<string>>(new Set());
  const attemptedPresetAutoStartRef = useRef<string | null>(null);
  const walkDiscoveryCheckoutCompletionRef = useRef<string | null>(null);

  const [step, setStep] = useState<FlowStep>("landing");
  const [documentVisibility, setDocumentVisibility] = useState<JamVisibilityState>(() =>
    typeof document === "undefined" ? "visible" : document.visibilityState
  );
  const toggleLandingTheme = useCallback(() => {
    setLandingTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"));
  }, []);

  // For MVP: Salem-only. This just controls whether we use geolocation-derived distances.
  const [geoAllowed, setGeoAllowed] = useState<boolean | null>(null);
  const [myPos, setMyPos] = useState<{ lat: number; lng: number } | null>(null);
  const [isNearbyStoryEnabled, setIsNearbyStoryEnabled] = useState(DEFAULT_NEARBY_STORY_ENABLED);

  useEffect(() => {
    let cancelled = false;

    async function syncAuthUser() {
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      setAuthUserEmail(data.user?.email?.trim() || null);
    }

    void syncAuthUser();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void syncAuthUser();
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  const jamIdFromUrl = searchParams.get("jam");
  const startPresetRouteFromUrl = searchParams.get("startPresetRoute");
  const walkDiscoveryCheckoutStatus = (searchParams.get("walkDiscoveryCheckout") || "").trim();
  const walkDiscoveryCheckoutPurchaseKey = (searchParams.get("walkDiscoveryPurchaseKey") || "").trim();
  const walkDiscoveryCheckoutSessionId = (searchParams.get("session_id") || "").trim();
  const debugStepFromUrl = searchParams.get("debugStep");
  const debugPerfEnabled = searchParams.get("debugPerf") === "1";
  const showPresetWalkRefresh = TRUTHY_FLAG_VALUES.includes(
    (searchParams.get("showRefresh") || "").trim().toLowerCase()
  );
  const showLandingThemeToggle = true;
  const nextLandingTheme = landingTheme === "dark" ? "light" : "dark";

  // Derive route + stop from jam
  const route: RouteDef | null = useMemo(() => customRoute, [customRoute]);
  const persona: Persona = (jam?.persona ?? "adult") as Persona;
  const isWalkDiscoveryRoute = route?.experienceKind === "walk_discovery";
  const isPresetWalkRoute = Boolean(jam?.route_id && !jam.route_id.startsWith("custom:"));
  const currentStopIndex = useMemo(() => {
    if (!route || activeStopIndex === null) return null;
    return clamp(activeStopIndex, 0, route.stops.length - 1);
  }, [activeStopIndex, route]);

  const currentStop = route && currentStopIndex !== null ? route.stops[currentStopIndex] : null;
  const currentStopSourceLabel = currentStop ? formatStopSourceLabel(currentStop) : null;
  const currentStopScript = useMemo(() => {
    if (!currentStop) return "";
    return currentStop?.text?.[persona] || "";
  }, [currentStop, persona]);
  const currentStopAudio = useMemo(() => {
    if (!currentStop) return "";
    return (currentStop.audio[persona] || "").trim();
  }, [currentStop, persona]);
  const hasCurrentAudio = currentStopAudio.length > 0;
  const jamTrackingMode = step === "walk" ? "walk" : step === "followAlongDrive" ? "followAlongDrive" : "idle";
  const isJamVisible = isJamDocumentVisible(documentVisibility);
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
          .map((routeId) => getPresetRouteSummaryById(routeId))
          .filter((route): route is PresetRouteSummary => Boolean(route)),
      })).filter((section) => section.routes.length > 0),
    []
  );
  const routesForSelectedCity = useMemo(() => getPresetRouteSummariesByCity(selectedCity), [selectedCity]);
  const selectedRoute = useMemo(
    () => (selectedRouteId ? getPresetRouteSummaryById(selectedRouteId) : null),
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
  const activePersonaDisplayName = getRouteNarratorLabel(route, persona);
  const isSocialAttributedCustomRoute =
    !isPresetWalkRoute &&
    (route?.storyBySource === "instagram" || route?.storyBySource === "tiktok" || route?.storyBySource === "social") &&
    Boolean(route?.storyBy?.trim());
  const instagramStoryByLabel = isSocialAttributedCustomRoute ? route?.storyBy?.trim() || null : null;
  const instagramStoryByUrl = isSocialAttributedCustomRoute ? route?.storyByUrl?.trim() || null : null;
  const instagramStoryByAvatarUrl = isSocialAttributedCustomRoute ? route?.storyByAvatarUrl?.trim() || null : null;
  const shouldShowInstagramStoryAvatar = Boolean(instagramStoryByAvatarUrl && !didInstagramAvatarFail);
  const activeInstagramCustomRouteId =
    step === "walk" && isSocialAttributedCustomRoute ? getCustomRouteId(route?.id ?? null) : null;
  const activePresetWalkRouteId =
    step === "walk" && isPresetWalkRoute && jam?.route_id ? (jam.route_id as RouteDef["id"]) : null;
  const isActivePresetWalkRegenerating =
    activePresetWalkRouteId !== null &&
    pendingPresetRouteAction?.routeId === activePresetWalkRouteId &&
    pendingPresetRouteAction.mode === "regenerate";
  const commitDistanceToStop = useCallback((nextDistance: number | null) => {
    if (!hasMeaningfulNumberChange(lastDistanceToStopMRef.current, nextDistance, DISTANCE_TO_STOP_EPSILON_METERS)) {
      return false;
    }
    lastDistanceToStopMRef.current = nextDistance;
    setDistanceToStopM(nextDistance);
    return true;
  }, []);
  const commitProximity = useCallback((nextProximity: "far" | "near" | "arrived") => {
    if (lastProximityRef.current === nextProximity) return false;
    lastProximityRef.current = nextProximity;
    setProximity(nextProximity);
    return true;
  }, []);
  const commitFollowAlongRouteProgress = useCallback((nextProgress: number | null) => {
    if (
      !hasMeaningfulNumberChange(
        lastFollowAlongRouteProgressMRef.current,
        nextProgress,
        FOLLOW_ALONG_PROGRESS_EPSILON_METERS
      )
    ) {
      return false;
    }
    lastFollowAlongRouteProgressMRef.current = nextProgress;
    setFollowAlongRouteProgressM(nextProgress);
    return true;
  }, []);
  const commitFollowAlongOffRoute = useCallback((nextOffRoute: boolean) => {
    if (lastFollowAlongOffRouteRef.current === nextOffRoute) return false;
    lastFollowAlongOffRouteRef.current = nextOffRoute;
    setFollowAlongOffRoute(nextOffRoute);
    return true;
  }, []);
  const commitGeoPosition = useCallback(
    (
      coords: { lat: number; lng: number },
      options?: {
        force?: boolean;
        timestamp?: number;
      }
    ) => {
      const sample: GeoCommitSample = {
        lat: coords.lat,
        lng: coords.lng,
        timestamp: options?.timestamp ?? Date.now(),
      };
      latestRawGeoRef.current = sample;
      const decision = options?.force
        ? { shouldCommit: true }
        : shouldCommitGeoUpdate(lastCommittedGeoRef.current, sample);
      if (!decision.shouldCommit) return false;
      lastCommittedGeoRef.current = sample;
      perfTrackerRef.current.count("react_geo_commits");
      setMyPos((current) => {
        if (current && current.lat === coords.lat && current.lng === coords.lng) {
          return current;
        }
        return coords;
      });
      return true;
    },
    []
  );
  const isAiPersona = (personaKey: Persona) => personaCatalog[personaKey].displayName.startsWith("AI");
  const usesNarratorIcon = (personaKey: Persona) => personaKey === "custom" || isAiPersona(personaKey);
  const customNarratorEnabled = isCustomNarratorFlowSource(narratorFlowSource, isPresetWalkRoute);
  const narratorSelectionIsCustomOnly = customNarratorEnabled;
  const resolveNarratorSubmitSelection = useCallback(
    (personaOverride?: Persona, guidanceOverride?: string | null) => {
      const trimmedGuidance = (guidanceOverride ?? customNarratorGuidance).trim();
      if (narratorSelectionIsCustomOnly) {
        return {
          persona: (trimmedGuidance ? "custom" : "adult") as Persona,
          narratorGuidance: trimmedGuidance || null,
        };
      }

      return {
        persona: (personaOverride ?? selectedPersona) as Persona | null,
        narratorGuidance:
          (personaOverride ?? selectedPersona) === "custom" ? trimmedGuidance || null : null,
      };
    },
    [customNarratorGuidance, narratorSelectionIsCustomOnly, selectedPersona]
  );
  const narratorSubmitDisabled =
    (!narratorSelectionIsCustomOnly && !selectedPersona) ||
    isGeneratingMix ||
    isCreatingFollowAlong;
  const narratorSubmitLabel = returnToWalkOnClose
    ? "Update Narrator"
    : narratorFlowSource === "followAlong"
      ? (isCreatingFollowAlong ? "Building route..." : "Start Follow Along")
      : "Create Tour";
  const customNarratorHelpText =
    narratorFlowSource === "followAlong"
      ? "You can personalize the tone, topic, or perspective. If you skip this, your narrator with be focused on history."
      : "You can personalize the tone, topic, or perspective. If you skip this, your narrator with be focused on history.";
  const customNarratorPlaceholder =
    narratorFlowSource === "followAlong"
      ? "Road-trip voice for two adults who love architecture, local lore, and concise stories."
      : "Describe your narrator...";
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
      const stopWithImage = builderSelectedStops.find((stop) => (stop.image || "").trim().length > 0);
      if (stopWithImage) return toSafeStopImage(stopWithImage.image);
    }

    const presetRoute = selectedRouteId ? getPresetRouteSummaryById(selectedRouteId) : selectedRoute;
    if (presetRoute) return getLandingRouteImage(presetRoute);

    const routeStopWithImage = route?.stops.find((stop) => (stop.images[0] || "").trim().length > 0);
    if (routeStopWithImage) return toSafeStopImage(routeStopWithImage.images[0]);

    return DEFAULT_STOP_IMAGE;
  }, [builderSelectedStops, generationJobKind, route, selectedRoute, selectedRouteId]);
  const narratorPreviewStops = useMemo(() => {
    if (narratorFlowSource === "buildMix") {
      return builderSelectedStops;
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
  }, [builderSelectedStops, followAlongDestination, narratorFlowSource]);
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
    const tracker = perfTrackerRef.current;
    tracker.setEnabled(debugPerfEnabled);
    return () => {
      tracker.flush("home-client-unmount");
    };
  }, [debugPerfEnabled]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const syncVisibility = () => {
      const nextVisibility = document.visibilityState;
      setDocumentVisibility(nextVisibility);
      perfTrackerRef.current.flush(`visibility:${nextVisibility}`);
    };

    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, []);

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
  const loadJamById = useCallback(async (id: string) => {
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
  }, []);

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
  const updateJam = useCallback(async (patch: Partial<JamRow>): Promise<boolean> => {
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
  }, [jam]);

  function handleNarratorSelect(nextPersona: Persona) {
    setErr(null);
    setSelectedPersona(nextPersona);
    if (!customNarratorEnabled && nextPersona !== "custom") {
      setCustomNarratorGuidance((current) => current.trim());
    }
    if (narratorSelectionIsCustomOnly) {
      return;
    }
    void submitNarratorSelection(nextPersona);
  }

  async function submitNarratorSelection(personaOverride?: Persona) {
    const narratorSelection = resolveNarratorSubmitSelection(personaOverride);
    const personaForSubmit = narratorSelection.persona;
    if (!personaForSubmit) return;

    if (narratorFlowSource === "buildMix") {
      await startCustomMixGeneration(builderSelectedStops, personaForSubmit, {
        narratorGuidance: narratorSelection.narratorGuidance,
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
        narratorGuidance: narratorSelection.narratorGuidance,
        experienceKind: route.experienceKind === "walk_discovery" ? "walk_discovery" : "mix",
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
    setIsStartingWalkDiscovery(false);
    setWalkDiscoverySuggestion(null);
    setWalkDiscoveryCheckoutSuggestion(null);
    setIsResolvingWalkDiscoverySuggestion(false);
    setIsAcceptingWalkDiscoverySuggestion(false);
    setIsStartingWalkDiscoveryCheckout(false);
    setIsCompletingWalkDiscoveryCheckout(false);
    setWalkDiscoveryMagicLinkEmail("");
    setWalkDiscoveryMagicLinkMessage(null);
    setIsSendingWalkDiscoveryMagicLink(false);
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
    lastCommittedGeoRef.current = null;
    latestRawGeoRef.current = null;
    followAlongLastPositionRef.current = null;
    commitFollowAlongOffRoute(false);
    commitFollowAlongRouteProgress(null);
    commitDistanceToStop(null);
    commitProximity("far");
    setFollowAlongStatusCopy("Waiting for route preview");
    walkDiscoveryRecentPositionsRef.current = [];
    walkDiscoveryLastFetchPosRef.current = null;
    walkDiscoveryCooldownsRef.current = {};
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

  function openLandingJourneyModal() {
    setIsLandingJourneyModalOpen(true);
  }

  function closeLandingJourneyModal() {
    setIsLandingJourneyModalOpen(false);
  }

  async function launchLandingAlongTheWay() {
    closeLandingJourneyModal();
    await startWalkDiscoveryExperience();
  }

  function launchLandingMixStudio() {
    closeLandingJourneyModal();
    setSelectedCity("salem");
    setInstantDiscoveryCity(null);
    goToCreateOwnMixBuilder();
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function openFollowAlongSetup() {
    const sessionId = followAlongSessionRef.current + 1;
    followAlongSessionRef.current = sessionId;
    setErr(null);
    setSelectedRouteId(null);
    setSelectedPersona("custom");
    setCustomNarratorGuidance((current) => current);
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
      commitGeoPosition(coords, { force: true });
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
    const narratorSelection = resolveNarratorSubmitSelection(personaOverride);
    const personaForSubmit = narratorSelection.persona;
    if (!followAlongOrigin || !followAlongDestination || !personaForSubmit) {
      setErr("Choose a destination and storyteller first.");
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
            narratorGuidance: narratorSelection.narratorGuidance,
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
    const startedAt =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    perfTrackerRef.current.count("route_reloads");
    const customRouteId = getCustomRouteId(routeRef);
    const isCustom = Boolean(customRouteId);
    const presetRouteSummary = getPresetRouteSummaryById(routeRef);
    if (!isCustom && !presetRouteSummary) {
      setCustomRoute(null);
      return null;
    }
    const endpoint = isCustom
      ? `/api/custom-routes/${customRouteId}`
      : `/api/preset-routes/${routeRef}`;
    const headers = await withSupabaseAuthHeaders();
    const res = await fetch(endpoint, { cache: "no-store", headers });
    if (!res.ok && res.status === 402) {
      try {
        const lockedPayload = (await res.json()) as {
          access?: "locked";
          teaser?: {
            slug?: string;
          } | null;
        };
        if (lockedPayload.access === "locked") {
          const teaserSlug = lockedPayload.teaser?.slug?.trim();
          if (teaserSlug) {
            setErr(null);
            setCustomRoute(null);
            router.replace(`/journeys/${encodeURIComponent(teaserSlug)}`);
            return null;
          }
        }
      } catch {
        // Fall through to the generic error handling below if the locked payload is missing or malformed.
      }
    }
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
    const payload = (await res.json()) as
      | (CustomRouteResponse & { access?: "granted" })
      | {
          access: "locked";
          teaser?: {
            slug?: string;
          } | null;
        };
    if ("access" in payload && payload.access === "locked") {
      const teaserSlug = payload.teaser?.slug?.trim();
      if (teaserSlug) {
        router.replace(`/journeys/${encodeURIComponent(teaserSlug)}`);
      }
      setCustomRoute(null);
      return null;
    }
    const resolvedCity = isCustom
      ? (payload.route.city || "").trim().toLowerCase() || instantDiscoveryCity || "nearby"
      : (presetRouteSummary?.city ?? selectedCity);
    const mappedStops: RouteDef["stops"] = payload.stops.map((s, idx) => {
      const stopId = s.stop_id || `custom-${idx}`;
      return {
      id: stopId,
      title: s.title,
      lat: s.lat,
      lng: s.lng,
      googlePlaceId: (s.google_place_id || "").trim() || undefined,
      sourceProvider: s.source_provider ?? null,
      sourceKind: s.source_kind ?? null,
      sourceUrl: s.source_url ?? null,
      sourceId: s.source_id ?? null,
      sourceCreatorName: s.source_creator_name ?? null,
      sourceCreatorUrl: s.source_creator_url ?? null,
      sourceCreatorAvatarUrl: s.source_creator_avatar_url ?? null,
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
      defaultPersona: isCustom
        ? ((payload.route.narrator_default ?? jam?.persona ?? "adult") as RouteDef["defaultPersona"])
        : (presetRouteSummary?.defaultPersona ?? "adult"),
      storyBy: isCustom ? (payload.route.story_by || undefined) : presetRouteSummary?.storyBy,
      storyByUrl: isCustom ? (payload.route.story_by_url ?? null) : null,
      storyByAvatarUrl: isCustom
        ? (payload.route.story_by_avatar_url ?? null)
        : null,
      storyBySource: isCustom ? (payload.route.story_by_source ?? null) : null,
      narratorGuidance: isCustom ? (payload.route.narrator_guidance || "").trim() || null : null,
      pricing: isCustom ? undefined : presetRouteSummary?.pricing,
      city: isCustom ? toKnownCityOption(resolvedCity) : presetRouteSummary?.city,
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
    perfTrackerRef.current.timing(
      "route_reload_ms",
      (typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now()) - startedAt
    );
    return nextRoute;
  }, [selectedCity, jam?.persona, instantDiscoveryCity, router]);

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

  const persistWalkDiscoveryCooldown = useCallback(
    (candidateKey: string, until = Date.now() + WALK_DISCOVERY_COOLDOWN_MS) => {
      if (!jam?.id) return;
      const nextCooldowns = pruneWalkDiscoveryCooldowns({
        ...walkDiscoveryCooldownsRef.current,
        [candidateKey]: until,
      });
      walkDiscoveryCooldownsRef.current = nextCooldowns;
      saveWalkDiscoveryCooldowns(jam.id, nextCooldowns);
    },
    [jam?.id]
  );

  const invalidateWalkDiscoverySuggestionRequests = useCallback(() => {
    walkDiscoveryRequestIdRef.current += 1;
    setIsResolvingWalkDiscoverySuggestion(false);
  }, []);

  const generateWalkDiscoveryAcceptedStopAssets = useCallback(async (
    routeRef: string,
    routeId: string,
    stopId: string,
    initialRoute?: RouteDef | null
  ) => {
    const resolveStop = (candidateRoute: RouteDef | null | undefined) =>
      candidateRoute?.stops.find((stop) => stop.id === stopId) ?? null;

    setIsGeneratingWalkDiscoveryAcceptedStopAssets(true);
    try {
      const loadedRoute = initialRoute ?? (await loadResolvedRoute(routeRef));
      const acceptedStop = resolveStop(loadedRoute);
      if (!acceptedStop) return;

      const needsScript = !((acceptedStop.text?.[persona] || "").trim());
      let needsAudio = !((acceptedStop.audio[persona] || "").trim());

      if (!needsScript && !needsAudio) {
        setPendingAutoplayStopId(stopId);
        return;
      }

      const customRouteId = getCustomRouteId(routeRef) || routeId;
      if (!customRouteId) return;

      if (needsScript) {
        await fetchJsonWithTimeout<{ script?: string; reused?: boolean; error?: string }>(
          "/api/custom-scripts/generate",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              routeId: customRouteId,
              stopId,
              persona,
              city: customRouteCity,
            }),
          },
          BACKGROUND_GENERATION_TIMEOUT_MS
        );
        needsAudio = true;
      }

      if (needsAudio) {
        await fetchJsonWithTimeout<{ audioUrl?: string; reused?: boolean; error?: string }>(
          "/api/custom-audio/generate",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              routeId: customRouteId,
              stopId,
              persona,
              city: customRouteCity,
            }),
          },
          BACKGROUND_GENERATION_TIMEOUT_MS
        );
      }

      const refreshedRoute = await loadResolvedRoute(routeRef);
      const refreshedStop = resolveStop(refreshedRoute);
      if ((refreshedStop?.audio[persona] || "").trim()) {
        setPendingAutoplayStopId(stopId);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to generate accepted stop audio.");
    } finally {
      setIsGeneratingWalkDiscoveryAcceptedStopAssets(false);
    }
  }, [customRouteCity, loadResolvedRoute, persona]);

  const refreshWalkDiscoverySuggestion = useCallback(async (force = false) => {
    perfTrackerRef.current.count("walk_discovery_refresh_attempts");
    if (!jam?.id || !isWalkDiscoveryRoute) return;
    if (!shouldRunWalkDiscoveryWork(documentVisibility, isWalkDiscoveryRoute)) return;
    if (
      isResolvingWalkDiscoverySuggestion ||
      isAcceptingWalkDiscoverySuggestion ||
      isGeneratingWalkDiscoveryAcceptedStopAssets
    ) {
      return;
    }

    let coords = latestRawGeoRef.current
      ? { lat: latestRawGeoRef.current.lat, lng: latestRawGeoRef.current.lng }
      : myPos;
    if (!coords) {
      try {
        coords = await requestCurrentGeoPosition();
        commitGeoPosition(coords, { force: true });
        setGeoAllowed(true);
      } catch {
        setGeoAllowed(false);
        return;
      }
    }
    if (!coords) return;

    const lastAcceptedStop = route?.stops[route.stops.length - 1] ?? null;
    if (
      lastAcceptedStop &&
      haversineMeters(
        coords.lat,
        coords.lng,
        lastAcceptedStop.lat,
        lastAcceptedStop.lng
      ) < WALK_DISCOVERY_MIN_DISTANCE_FROM_ACCEPTED_METERS
    ) {
      return;
    }

    const lastFetchPos = walkDiscoveryLastFetchPosRef.current;
    if (
      !force &&
      lastFetchPos &&
      haversineMeters(coords.lat, coords.lng, lastFetchPos.lat, lastFetchPos.lng) <
        WALK_DISCOVERY_FETCH_MIN_MOVE_METERS
    ) {
      return;
    }

    const acceptedCandidateKeys = (route?.stops ?? []).map((stop) =>
      buildRouteStopCandidateKey(stop)
    );

    const requestId = walkDiscoveryRequestIdRef.current + 1;
    walkDiscoveryRequestIdRef.current = requestId;
    walkDiscoveryLastFetchPosRef.current = coords;
    setIsResolvingWalkDiscoverySuggestion(true);

    try {
      const body = await fetchJsonWithTimeout<WalkDiscoverySuggestResponse>(
        "/api/walk-discovery/suggest",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jamId: jam.id,
            lat: coords.lat,
            lng: coords.lng,
            recentPositions: walkDiscoveryRecentPositionsRef.current,
            acceptedCandidateKeys,
            cooldownCandidateKeys: Object.keys(
              pruneWalkDiscoveryCooldowns(walkDiscoveryCooldownsRef.current)
            ),
          }),
        },
        START_JOB_TIMEOUT_MS
      );
      if (requestId !== walkDiscoveryRequestIdRef.current) return;
      setWalkDiscoverySuggestion(body.suggestion);
    } catch (e) {
      if (requestId !== walkDiscoveryRequestIdRef.current) return;
      setErr(e instanceof Error ? e.message : "Failed to refresh nearby suggestion.");
    } finally {
      if (requestId === walkDiscoveryRequestIdRef.current) {
        setIsResolvingWalkDiscoverySuggestion(false);
      }
    }
  }, [
    jam?.id,
    isWalkDiscoveryRoute,
    documentVisibility,
    isResolvingWalkDiscoverySuggestion,
    isAcceptingWalkDiscoverySuggestion,
    isGeneratingWalkDiscoveryAcceptedStopAssets,
    myPos,
    route,
    commitGeoPosition,
  ]);

  async function startWalkDiscoveryExperience() {
    if (
      !isNearbyStoryEnabled ||
      isStartingWalkDiscovery ||
      isResolvingNearbyGeo
    ) {
      return;
    }

    try {
      setErr(null);
      setIsStartingWalkDiscovery(true);
      setGenerationJobId(null);
      setGenerationJobKind(null);
      setGenerationProgress(15);
      setGenerationStatusLabel(GENERATION_STATUS_LABELS.generating_script);
      setGenerationMessage("Finding a story near you...");
      setStep("generating");

      let coords = myPos;
      if (!coords) {
        setIsResolvingNearbyGeo(true);
        coords = await requestCurrentGeoPosition();
        commitGeoPosition(coords, { force: true });
        setGeoAllowed(true);
      }

      const body = await fetchJsonWithTimeout<WalkDiscoveryStartResponse>(
        "/api/walk-discovery/start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jamId: jam?.id ?? null,
            lat: coords.lat,
            lng: coords.lng,
            persona: "adult",
          }),
        },
        START_JOB_TIMEOUT_MS
      );

      router.replace(`/?jam=${body.jamId}`);
      setWalkDiscoverySuggestion(null);
      await loadJamById(body.jamId);
      setPendingAutoplayStopId(body.insertedStopId);
    } catch (e) {
      setGenerationJobId(null);
      setGenerationJobKind(null);
      setGenerationProgress(0);
      setStep("landing");
      setErr(e instanceof Error ? e.message : "Failed to start Wander.");
    } finally {
      setIsResolvingNearbyGeo(false);
      setIsStartingWalkDiscovery(false);
    }
  }

  async function rejectWalkDiscoverySuggestion() {
    if (!walkDiscoverySuggestion) return;
    persistWalkDiscoveryCooldown(walkDiscoverySuggestion.candidateKey);
    setWalkDiscoveryCheckoutSuggestion(null);
    setWalkDiscoveryMagicLinkMessage(null);
    setWalkDiscoverySuggestion((current) =>
      current ? { ...current, status: "rejected" } : current
    );
    window.setTimeout(() => {
      setWalkDiscoverySuggestion(null);
      void refreshWalkDiscoverySuggestion(true);
    }, 0);
  }

  const finalizeWalkDiscoverySuggestionAcceptance = useCallback(async (
    acceptedSuggestion: WalkDiscoverySuggestion,
    options?: {
      purchaseKey?: string | null;
      stripeCheckoutSessionId?: string | null;
    }
  ) => {
    if (!jam?.id || isAcceptingWalkDiscoverySuggestion) return false;

    setIsAcceptingWalkDiscoverySuggestion(true);
    setErr(null);
    setWalkDiscoveryMagicLinkMessage(null);

    try {
      const headers = await withSupabaseAuthHeaders({ "Content-Type": "application/json" });
      const body = await fetchJsonWithTimeout<WalkDiscoveryAcceptResponse>(
        "/api/walk-discovery/accept",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            jamId: jam.id,
            persona,
            candidate: {
              id: acceptedSuggestion.id,
              title: acceptedSuggestion.title,
              lat: acceptedSuggestion.lat,
              lng: acceptedSuggestion.lng,
              image: acceptedSuggestion.image,
              source: acceptedSuggestion.source,
              distanceMeters: acceptedSuggestion.distanceMeters,
              googlePlaceId: acceptedSuggestion.googlePlaceId ?? undefined,
            },
            purchaseKey: options?.purchaseKey ?? null,
            stripeCheckoutSessionId: options?.stripeCheckoutSessionId ?? null,
          }),
        },
        START_JOB_TIMEOUT_MS
      );

      persistWalkDiscoveryCooldown(acceptedSuggestion.candidateKey);
      invalidateWalkDiscoverySuggestionRequests();
      setWalkDiscoverySuggestion(null);
      setWalkDiscoveryCheckoutSuggestion(null);
      await loadJamById(body.jamId);
      const nextRoute = await loadResolvedRoute(body.routeRef);
      await generateWalkDiscoveryAcceptedStopAssets(
        body.routeRef,
        body.routeId,
        body.insertedStopId,
        nextRoute
      );
      if (options?.purchaseKey) {
        clearPendingWalkDiscoveryCheckout(jam.id, options.purchaseKey);
      }
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to accept nearby stop.");
      return false;
    } finally {
      setIsAcceptingWalkDiscoverySuggestion(false);
    }
  }, [
    generateWalkDiscoveryAcceptedStopAssets,
    invalidateWalkDiscoverySuggestionRequests,
    isAcceptingWalkDiscoverySuggestion,
    jam?.id,
    loadJamById,
    loadResolvedRoute,
    persona,
    persistWalkDiscoveryCooldown,
  ]);

  async function sendWalkDiscoveryMagicLink() {
    if (!jam?.id || authUserEmail || isSendingWalkDiscoveryMagicLink) return;
    const email = walkDiscoveryMagicLinkEmail.trim().toLowerCase();
    if (!email) {
      setErr("Enter your email address.");
      return;
    }

    setIsSendingWalkDiscoveryMagicLink(true);
    setErr(null);
    setWalkDiscoveryMagicLinkMessage(null);

    try {
      const response = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          next: `/?jam=${encodeURIComponent(jam.id)}`,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || "Failed to send magic link.");
      }
      setWalkDiscoveryMagicLinkMessage(MAGIC_LINK_SUCCESS_MESSAGE);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to send magic link.");
    } finally {
      setIsSendingWalkDiscoveryMagicLink(false);
    }
  }

  async function startWalkDiscoveryCheckout(suggestion: WalkDiscoverySuggestion) {
    if (!jam?.id || isStartingWalkDiscoveryCheckout) return;

    setIsStartingWalkDiscoveryCheckout(true);
    setErr(null);
    setWalkDiscoveryMagicLinkMessage(null);

    try {
      const headers = await withSupabaseAuthHeaders({ "Content-Type": "application/json" });
      const body = await fetchJsonWithTimeout<WalkDiscoveryCheckoutSessionResponse>(
        "/api/walk-discovery/checkout",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            jamId: jam.id,
            suggestion: {
              candidateKey: suggestion.candidateKey,
              title: suggestion.title,
              purchaseKey: suggestion.purchaseKey,
            },
          }),
        },
        START_JOB_TIMEOUT_MS
      );
      if (!body.url) {
        throw new Error("Failed to start checkout.");
      }

      savePendingWalkDiscoveryCheckout({
        jamId: jam.id,
        suggestion,
      });
      window.location.href = body.url;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to start checkout.");
      setIsStartingWalkDiscoveryCheckout(false);
    }
  }

  async function acceptWalkDiscoverySuggestion() {
    if (!walkDiscoverySuggestion) return;

    if (!walkDiscoverySuggestion.isIncluded && !walkDiscoverySuggestion.isFree) {
      setErr(null);
      setWalkDiscoveryMagicLinkMessage(null);
      setWalkDiscoveryCheckoutSuggestion(walkDiscoverySuggestion);
      if (!authUserEmail) {
        setWalkDiscoveryMagicLinkEmail((current) => current || "");
      }
      return;
    }

    await finalizeWalkDiscoverySuggestionAcceptance(walkDiscoverySuggestion);
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
        commitGeoPosition(coords, { force: true });
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

  async function handleStopSelect(idx: number, opts?: { autoPlay?: boolean }) {
    if (!route) return;
    const stop = route.stops[idx];
    setActiveStopIndex(idx);
    setPendingAutoplayStopId(opts?.autoPlay ? stop?.id ?? null : null);
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
      await handleStopSelect(0, { autoPlay: true });
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
    const presetSummary = getPresetRouteSummaryById(routeId);
    if (!presetSummary) {
      setErr("Unknown preset route");
      return;
    }
    if (presetSummary.requiresPurchase && !options?.allowPaidStart) {
      router.push(`/journeys/${encodeURIComponent(routeId)}`);
      return;
    }

    const routeCity = (presetSummary.city ?? selectedCity) as CityOption;
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
      const headers = await withSupabaseAuthHeaders({ "Content-Type": "application/json" });
      const res = await fetch("/api/preset-jobs/create", {
        method: "POST",
        headers,
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
    const selectedRoute = getPresetRouteSummaryById(routeId);
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
    if (selectedRoute.requiresPurchase) {
      router.push(`/journeys/${encodeURIComponent(routeId)}`);
      return;
    }
    await startPresetTour(routeId, selectedRoute.defaultPersona);
  }

  async function regeneratePresetRoute(routeId: RouteDef["id"]) {
    const selectedRoute = selectPresetRoute(routeId);
    if (!selectedRoute) return;
    await startPresetTour(routeId, selectedRoute.defaultPersona, {
      forceRegenerateAll: true,
      allowPaidStart: true,
    });
  }

  function toggleBuilderStop(stop: CustomMixStop) {
    setErr(null);
    setBuilderSelectedStops((prev) => {
      const exists = prev.some((s) => stopMatches(s, stop));
      if (exists) {
        return prev.filter((s) => !stopMatches(s, stop));
      }
      const nextMaxStops = getMaxStops();
      if (nextMaxStops > 0 && prev.length >= nextMaxStops) {
        setErr(`Select at most ${nextMaxStops} stops.`);
        return prev;
      }
      return [...prev, stop];
    });
  }

  function moveSelectedStop(stop: CustomMixStop, direction: "up" | "down") {
    setErr(null);
    setBuilderSelectedStops((prev) => {
      const currentIdx = prev.findIndex((candidate) => stopMatches(candidate, stop));
      if (currentIdx < 0) return prev;
      const nextIdx = direction === "up" ? currentIdx - 1 : currentIdx + 1;
      return moveItem(prev, currentIdx, nextIdx);
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
    const narratorSelection = resolveNarratorSubmitSelection(
      personaOverride,
      options?.narratorGuidance
    );
    const personaForGeneration = narratorSelection.persona;
    const narratorGuidance = narratorSelection.narratorGuidance;
    if (!stopsToGenerate.length || !personaForGeneration) return false;
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
              experienceKind: options?.experienceKind ?? "mix",
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

    const customRouteId = getCustomRouteId(route.id);
    if (customRouteId) {
      try {
        setErr(null);
        const response = await fetch(`/api/custom-routes/${encodeURIComponent(customRouteId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stopIds: nextStops.map((stop) => stop.id),
          }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || "Failed to save route changes");
        }

        await loadResolvedRoute(route.id);
        setActiveStopIndex(null);
        setIsEditingStopsFromWalk(false);
        setReturnToWalkOnClose(false);
        setStep("walk");
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to save route changes");
      }
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
  }, [jamIdFromUrl, debugStepFromUrl, loadJamById]);

  useEffect(() => {
    if (jamIdFromUrl) return;
    const routeId = (startPresetRouteFromUrl || "").trim();
    if (!routeId) return;
    if (attemptedPresetAutoStartRef.current === routeId) return;
    const presetRoute = getPresetRouteSummaryById(routeId);
    if (!presetRoute) return;

    attemptedPresetAutoStartRef.current = routeId;
    if (presetRoute.city) {
      setSelectedCity(presetRoute.city);
    }
    setSelectedRouteId(routeId);
    setSelectedPersona(presetRoute.defaultPersona);
    void startPresetTour(routeId, presetRoute.defaultPersona, { allowPaidStart: true });
  // `startPresetTour` is recreated per render; the ref guard above keeps this one-shot URL action stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jamIdFromUrl, startPresetRouteFromUrl]);

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
  }, [step, generationJobId, generationJobKind, loadResolvedRoute, selectedPersona, jam?.persona, loadJamById]);

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
    jamCurrentStopRef.current =
      typeof jam?.current_stop === "number" && jam.current_stop >= 0
        ? jam.current_stop
        : null;
  }, [jam?.current_stop]);

  useEffect(() => {
    if (!route || route.experienceKind !== "follow_along") return;
    setActiveStopIndex(
      typeof jam?.current_stop === "number" && jam.current_stop >= 0
        ? jam.current_stop
        : null
    );
  }, [route, jam?.current_stop]);

  useEffect(() => {
    if (!isWalkDiscoveryRoute) return;
    setActiveStopIndex(
      typeof jam?.current_stop === "number" && jam.current_stop >= 0
        ? jam.current_stop
        : null
    );
  }, [isWalkDiscoveryRoute, jam?.current_stop]);

  useEffect(() => {
    if (!jam?.id) {
      walkDiscoveryCooldownsRef.current = {};
      walkDiscoveryRecentPositionsRef.current = [];
      walkDiscoveryLastFetchPosRef.current = null;
      walkDiscoveryCheckoutCompletionRef.current = null;
      setWalkDiscoverySuggestion(null);
      return;
    }
    walkDiscoveryCooldownsRef.current = loadWalkDiscoveryCooldowns(jam.id);
    walkDiscoveryRecentPositionsRef.current = [];
    walkDiscoveryLastFetchPosRef.current = null;
    walkDiscoveryCheckoutCompletionRef.current = null;
    setWalkDiscoverySuggestion(null);
  }, [jam?.id]);

  useEffect(() => {
    lastCommittedGeoRef.current = null;
    latestRawGeoRef.current = null;
    followAlongLastPositionRef.current = null;
    lastDistanceToStopMRef.current = null;
    lastProximityRef.current = "far";
    lastFollowAlongRouteProgressMRef.current = null;
    lastFollowAlongOffRouteRef.current = false;
  }, [jam?.id]);

  useEffect(() => {
    if (step === "walk" && isWalkDiscoveryRoute) return;
    setWalkDiscoverySuggestion(null);
    setWalkDiscoveryCheckoutSuggestion(null);
  }, [step, isWalkDiscoveryRoute]);

  useEffect(() => {
    if (!walkDiscoverySuggestion || !route) return;
    const acceptedCandidateKeys = new Set(
      route.stops.map((stop) => buildRouteStopCandidateKey(stop))
    );
    if (!acceptedCandidateKeys.has(walkDiscoverySuggestion.candidateKey)) return;
    setWalkDiscoverySuggestion(null);
  }, [walkDiscoverySuggestion, route]);

  useEffect(() => {
    if (!jamIdFromUrl || !walkDiscoveryCheckoutStatus || !walkDiscoveryCheckoutPurchaseKey) return;

    if (walkDiscoveryCheckoutStatus === "cancelled") {
      const pending = loadPendingWalkDiscoveryCheckout(jamIdFromUrl, walkDiscoveryCheckoutPurchaseKey);
      if (pending?.suggestion) {
        setWalkDiscoverySuggestion(pending.suggestion);
      }
      clearPendingWalkDiscoveryCheckout(jamIdFromUrl, walkDiscoveryCheckoutPurchaseKey);
      setWalkDiscoveryCheckoutSuggestion(null);
      setWalkDiscoveryMagicLinkMessage(null);
      setErr("Checkout was cancelled. This stop is still available.");
      router.replace(`/?jam=${jamIdFromUrl}`);
      return;
    }

    if (walkDiscoveryCheckoutStatus !== "success" || !walkDiscoveryCheckoutSessionId) return;
    if (!jam?.id || jam.id !== jamIdFromUrl) return;

    const completionKey = `${walkDiscoveryCheckoutStatus}:${walkDiscoveryCheckoutPurchaseKey}:${walkDiscoveryCheckoutSessionId}`;
    if (walkDiscoveryCheckoutCompletionRef.current === completionKey) return;
    walkDiscoveryCheckoutCompletionRef.current = completionKey;

    let cancelled = false;
    setIsCompletingWalkDiscoveryCheckout(true);
    setErr(null);

    void (async () => {
      const pending = loadPendingWalkDiscoveryCheckout(
        jamIdFromUrl,
        walkDiscoveryCheckoutPurchaseKey
      );
      if (!pending?.suggestion) {
        if (!cancelled) {
          setErr("Payment received. Refresh the nearby stop to continue.");
          setIsCompletingWalkDiscoveryCheckout(false);
          router.replace(`/?jam=${jamIdFromUrl}`);
        }
        return;
      }

      const accepted = await finalizeWalkDiscoverySuggestionAcceptance(
        pending.suggestion,
        {
          purchaseKey: walkDiscoveryCheckoutPurchaseKey,
          stripeCheckoutSessionId: walkDiscoveryCheckoutSessionId,
        }
      );
      if (cancelled) return;
      if (accepted) {
        clearPendingWalkDiscoveryCheckout(jamIdFromUrl, walkDiscoveryCheckoutPurchaseKey);
      }
      setIsCompletingWalkDiscoveryCheckout(false);
      router.replace(`/?jam=${jamIdFromUrl}`);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    finalizeWalkDiscoverySuggestionAcceptance,
    jam?.id,
    jamIdFromUrl,
    router,
    walkDiscoveryCheckoutPurchaseKey,
    walkDiscoveryCheckoutSessionId,
    walkDiscoveryCheckoutStatus,
  ]);

// ---------- watchPosition ----------
  useEffect(() => {
    if (step !== "walk") return;
    if (!shouldRunJamGeoTracking(jamTrackingMode, documentVisibility)) return;
    if (!navigator.geolocation) return;

    let watchId: number | null = null;

    try {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          perfTrackerRef.current.count("walk_geo_ticks");
          const nextPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          commitGeoPosition(nextPos, { timestamp: pos.timestamp });
          setGeoAllowed(true);
          walkDiscoveryRecentPositionsRef.current = appendWalkDiscoveryPosition(
            walkDiscoveryRecentPositionsRef.current,
            {
              ...nextPos,
              timestamp: pos.timestamp,
            }
          );

          if (!currentStop) {
            commitDistanceToStop(null);
            commitProximity("far");
          } else {
            const meters = haversineMeters(nextPos.lat, nextPos.lng, currentStop.lat, currentStop.lng);
            commitDistanceToStop(meters);

            if (meters <= 35) commitProximity("arrived");
            else if (meters <= 80) commitProximity("near");
            else commitProximity("far");
          }

          if (
            shouldRunWalkDiscoveryWork(documentVisibility, isWalkDiscoveryRoute) &&
            !walkDiscoverySuggestion
          ) {
            void refreshWalkDiscoverySuggestion(false);
          }
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
  }, [
    step,
    jamTrackingMode,
    documentVisibility,
    currentStop,
    isWalkDiscoveryRoute,
    walkDiscoverySuggestion,
    refreshWalkDiscoverySuggestion,
    commitGeoPosition,
    commitDistanceToStop,
    commitProximity,
  ]);

  useEffect(() => {
    if (step !== "followAlongDrive") return;
    if (!shouldRunJamGeoTracking(jamTrackingMode, documentVisibility)) return;
    if (!route || route.experienceKind !== "follow_along") return;
    const routeCoords = route.routePathCoords ?? null;
    if (!routeCoords || routeCoords.length < 2) return;
    if (!navigator.geolocation) return;

    let watchId: number | null = null;

    const evaluatePosition = async (
      nextPos: { lat: number; lng: number },
      speedMps: number | null
    ) => {
      setGeoAllowed(true);

      const progress = normalizeRouteProgress(nextPos, routeCoords);
      commitFollowAlongRouteProgress(progress.distanceAlongMeters);

      const isOffRoute = progress.distanceToRouteMeters > 180;
      commitFollowAlongOffRoute(isOffRoute);
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

      commitDistanceToStop(
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
          perfTrackerRef.current.count("follow_along_geo_ticks");
          const nextPos = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          };
          commitGeoPosition(nextPos, { timestamp: pos.timestamp });
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
  }, [
    step,
    jamTrackingMode,
    documentVisibility,
    route,
    currentStopIndex,
    activeStopIndex,
    updateJam,
    commitGeoPosition,
    commitDistanceToStop,
    commitFollowAlongRouteProgress,
    commitFollowAlongOffRoute,
  ]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const onTimeUpdate = () => setAudioTime(el.currentTime || 0);
    const onLoadedMeta = () => {
      setAudioDuration(Number.isFinite(el.duration) ? el.duration : 0);
      setAudioTime(el.currentTime || 0);
    };
    const onPlay = () => {
      perfTrackerRef.current.count("audio_play_events");
      setIsPlaying(true);
    };
    const onPause = () => {
      perfTrackerRef.current.count("audio_pause_events");
      setIsPlaying(false);
    };
    const onEnded = () => {
      perfTrackerRef.current.count("audio_ended_events");
      setIsPlaying(false);
    };

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
    const previousVisibility = previousVisibilityRef.current;
    previousVisibilityRef.current = documentVisibility;
    if (!isJamVisible || previousVisibility !== "hidden") return;

    if (step === "followAlongDrive" && route?.experienceKind === "follow_along") {
      const routeCoords = route.routePathCoords ?? null;
      if (!routeCoords || routeCoords.length < 2) return;

      void requestCurrentGeoPosition()
        .then((coords) => {
          const timestamp = Date.now();
          followAlongLastPositionRef.current = { ...coords, timestamp };
          commitGeoPosition(coords, { force: true, timestamp });
          const progress = normalizeRouteProgress(coords, routeCoords);
          commitFollowAlongRouteProgress(progress.distanceAlongMeters);
          commitFollowAlongOffRoute(progress.distanceToRouteMeters > 180);
          setGeoAllowed(true);
        })
        .catch(() => {
          setGeoAllowed(false);
        });
      return;
    }

    if (step !== "walk") return;

    void requestCurrentGeoPosition()
      .then((coords) => {
        const timestamp = Date.now();
        commitGeoPosition(coords, { force: true, timestamp });
        setGeoAllowed(true);
        if (currentStop) {
          const meters = haversineMeters(coords.lat, coords.lng, currentStop.lat, currentStop.lng);
          commitDistanceToStop(meters);
          if (meters <= 35) commitProximity("arrived");
          else if (meters <= 80) commitProximity("near");
          else commitProximity("far");
        }
        if (shouldRunWalkDiscoveryWork(documentVisibility, isWalkDiscoveryRoute) && jam?.id) {
          setWalkDiscoverySuggestion(null);
          walkDiscoveryLastFetchPosRef.current = null;
          void refreshWalkDiscoverySuggestion(true);
        }
      })
      .catch(() => {
        setGeoAllowed(false);
      });
  }, [
    documentVisibility,
    isJamVisible,
    step,
    route,
    currentStop,
    isWalkDiscoveryRoute,
    jam?.id,
    commitGeoPosition,
    commitDistanceToStop,
    commitProximity,
    commitFollowAlongRouteProgress,
    commitFollowAlongOffRoute,
    refreshWalkDiscoverySuggestion,
  ]);

  useEffect(() => {
    if (!walkDiscoverySuggestion) return;
    if (!isJamVisible) return;
    if (
      !shouldExpireWalkDiscoverySuggestion({
        suggestion: walkDiscoverySuggestion,
        currentPosition: myPos,
      })
    ) {
      const timeoutMs = Math.max(0, walkDiscoverySuggestion.expiresAt - Date.now());
      const timeoutId = window.setTimeout(() => {
        if (!walkDiscoverySuggestion) return;
        persistWalkDiscoveryCooldown(walkDiscoverySuggestion.candidateKey);
        setWalkDiscoverySuggestion((current) =>
          current ? { ...current, status: "expired" } : current
        );
        window.setTimeout(() => {
          setWalkDiscoverySuggestion(null);
          void refreshWalkDiscoverySuggestion(true);
        }, 0);
      }, timeoutMs);
      return () => {
        window.clearTimeout(timeoutId);
      };
    }

    persistWalkDiscoveryCooldown(walkDiscoverySuggestion.candidateKey);
    setWalkDiscoverySuggestion((current) =>
      current ? { ...current, status: "expired" } : current
    );
    const nextTick = window.setTimeout(() => {
      setWalkDiscoverySuggestion(null);
      void refreshWalkDiscoverySuggestion(true);
    }, 0);
    return () => {
      window.clearTimeout(nextTick);
    };
  }, [walkDiscoverySuggestion, myPos, isJamVisible, persistWalkDiscoveryCooldown, refreshWalkDiscoverySuggestion]);

  useEffect(() => {
    if ((step === "walk" || step === "followAlongDrive") && currentStop) return;
    commitDistanceToStop(null);
    commitProximity("far");
  }, [step, currentStop, commitDistanceToStop, commitProximity]);

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
    if (route?.experienceKind === "follow_along" || route?.experienceKind === "walk_discovery") {
      setActiveStopIndex(jamCurrentStopRef.current);
    } else {
      setActiveStopIndex(null);
    }
    setPendingAutoplayStopId(null);
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    setIsPlaying(false);
    setAudioTime(0);
    setAudioDuration(0);
    commitDistanceToStop(null);
    commitProximity("far");
    commitFollowAlongRouteProgress(null);
    commitFollowAlongOffRoute(false);
  }, [
    step,
    route?.id,
    route?.experienceKind,
    commitDistanceToStop,
    commitProximity,
    commitFollowAlongRouteProgress,
    commitFollowAlongOffRoute,
  ]);

  useEffect(() => {
    if (step !== "pickDuration") return;
    if (returnToWalkOnClose && jam?.route_id) {
      const presetRoute = getPresetRouteSummaryById(jam.route_id);
      const routeId = presetRoute ? jam.route_id : null;
      if (presetRoute?.city) {
        setSelectedCity(presetRoute.city);
      }
      setSelectedRouteId(routeId);
      setSelectedPersona(routeId ? ((jam.persona ?? null) as Persona | null) : "custom");
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
  }, [step, isEditingStopsFromWalk, narratorFlowSource]);

  useEffect(() => {
    if (step !== "pickDuration" || !customNarratorEnabled) return;
    setSelectedPersona("custom");
  }, [step, customNarratorEnabled]);

  useEffect(() => {
    setDidInstagramAvatarFail(false);
  }, [instagramStoryByAvatarUrl, route?.id]);

  useEffect(() => {
    if (step !== "walk" || !isWalkDiscoveryRoute || !jam?.id) return;
    if (walkDiscoverySuggestion || isResolvingWalkDiscoverySuggestion) return;
    void refreshWalkDiscoverySuggestion(false);
  }, [
    step,
    isWalkDiscoveryRoute,
    jam?.id,
    route?.id,
    walkDiscoverySuggestion,
    isResolvingWalkDiscoverySuggestion,
    refreshWalkDiscoverySuggestion,
  ]);

  useEffect(() => {
    if (step !== "buildMix") return;
    if (myPos) return;
    let cancelled = false;

    void requestCurrentGeoPosition()
      .then((coords) => {
        if (cancelled) return;
        commitGeoPosition(coords, { force: true });
        setGeoAllowed(true);
      })
      .catch(() => {
        if (cancelled) return;
        setGeoAllowed(false);
      });

    return () => {
      cancelled = true;
    };
  }, [step, myPos, commitGeoPosition]);

  useEffect(() => {
    if (!["landing", "pickDuration", "buildMix", "followAlongSetup", "generating", "walk", "followAlongDrive"].includes(step)) return;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [step]);

  useEffect(() => {
    if (step !== "landing") return;

    const video = landingVideoRef.current;
    if (!video) return;

    let playCount = 1;

    video.pause();
    video.currentTime = 0;

    const startPlayback = () => {
      void video.play().catch(() => {
        // Ignore autoplay interruptions; the video stays muted and decorative.
      });
    };

    const freezeOnLastFrame = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      video.currentTime = Math.max(0, video.duration - 0.05);
      video.pause();
    };

    const onEnded = () => {
      if (playCount >= LANDING_VIDEO_MAX_PLAYS) {
        freezeOnLastFrame();
        return;
      }

      playCount += 1;
      video.currentTime = 0;
      startPlayback();
    };

    video.addEventListener("ended", onEnded);
    startPlayback();

    return () => {
      video.removeEventListener("ended", onEnded);
    };
  }, [step]);

  useEffect(() => {
    if (!isLandingJourneyModalOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeLandingJourneyModal();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isLandingJourneyModalOpen]);

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
            sourceLabel: formatStopSourceLabel(stop),
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
          sourceLabel: formatStopSourceLabel(stop),
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
        sourceLabel: formatStopSourceLabel(stop),
        isActive: idx === selectedIdx,
      };
    });
  }, [route, currentStopIndex]);

  const mapsUrl = useMemo(() => {
    if (!route) return "#";
    return buildGoogleMapsDirectionsUrl({
      stops: route.stops,
      endpoints: {
        origin: route.origin ? { lat: route.origin.lat, lng: route.origin.lng } : null,
        destination: route.destination ? { lat: route.destination.lat, lng: route.destination.lng } : null,
      },
      routeTravelMode: route.transportMode ?? null,
    });
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
  const showLandingDiscoverNearby = false;

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
              ref={landingVideoRef}
              className={styles.landingVideo}
              autoPlay
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
                  Turn the real world into story-driven journeys.
                </p>
                <div className={styles.landingHeroCtaWrap}>
                  <button
                    type="button"
                    onClick={openLandingJourneyModal}
                    className={styles.landingHeroCta}
                  >
                    Discover nearby
                  </button>
                  <button
                    type="button"
                    onClick={launchLandingMixStudio}
                    className={`${styles.landingHeroCta} ${styles.landingHeroCtaOutline}`}
                  >
                    Create
                  </button>
                </div>
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
                  Turn the real world into story-driven journeys.
                </p>
                <div className={styles.landingHeroCtaWrap}>
                  <button
                    type="button"
                    onClick={openLandingJourneyModal}
                    className={styles.landingHeroCta}
                  >
                    Create your journey
                  </button>
                </div>
              </div>
            </div>

            {featuredPresetSections.map((section) => (
              <div key={section.title}>
                <div className={styles.landingPopular}>{section.title}</div>

                <div className={styles.landingFeaturedGrid}>
                  {section.routes.map((r) => {
                    const pricingLabel = getRoutePricingLabel(r.pricing);
                    const stopCountLabel = formatStopCount(getPresetRouteSummaryStopCount(r));
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

            {showLandingDiscoverNearby && (
              <div className={styles.landingLocationSection}>
                <div className={styles.landingSecondaryLabel}>Discover Nearby</div>

                <div className={styles.landingLocationGrid}>
                  <button
                    type="button"
                    onClick={() => {
                      void handleNearbyStory();
                    }}
                    className={`${styles.landingLocationCard} ${isSurpriseMixDisabled ? styles.pickRouteRowDisabled : ""}`}
                    disabled={isSurpriseMixDisabled}
                    aria-label={`Around me. ${surpriseMixSubtitle}`}
                  >
                    <div className={`${styles.landingLocationImageWrap} ${styles.landingLocationIconWrap}`} aria-hidden="true">
                      <Image
                        src="/icons/pin-angle-fill.svg"
                        alt=""
                        width={28}
                        height={28}
                        className={styles.landingLocationIcon}
                        aria-hidden="true"
                      />
                    </div>
                    <div className={styles.landingLocationTitle}>Nearby</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      openPresetCity("nyc");
                    }}
                    className={styles.landingLocationCard}
                  >
                    <div className={styles.landingLocationImageWrap} aria-hidden="true">
                      <Image
                        src={getPresetCityMeta("nyc").fallbackImage}
                        alt=""
                        fill
                        unoptimized
                        sizes="(max-width: 720px) 40vw, 160px"
                        className={styles.landingLocationImage}
                      />
                    </div>
                    <div className={styles.landingLocationTitle}>New York City</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      openPresetCity("boston");
                    }}
                    className={styles.landingLocationCard}
                  >
                    <div className={styles.landingLocationImageWrap} aria-hidden="true">
                      <Image
                        src={getPresetCityMeta("boston").fallbackImage}
                        alt=""
                        fill
                        unoptimized
                        sizes="(max-width: 720px) 40vw, 160px"
                        className={styles.landingLocationImage}
                      />
                    </div>
                    <div className={styles.landingLocationTitle}>Boston</div>
                  </button>
                </div>
              </div>
            )}

            {INSTAGRAM_IMPORT_ENABLED ? (
              <section className={styles.creatorAccessCallout}>
                <div className={styles.creatorAccessCalloutCopy}>
                  <div className={styles.creatorAccessCalloutTitle}>
                    Mix your Instagram stories into real-world journeys others can explore.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    router.push("/import/mixed");
                  }}
                  className={styles.landingHeroCta}
                >
                  Unlock Creator Mix Studio
                </button>
              </section>
            ) : null}

            {showLandingThemeToggle && (
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
            )}

            {isLandingJourneyModalOpen && (
              <div
                className={styles.landingJourneyModalOverlay}
                role="dialog"
                aria-modal="true"
                aria-label="Stories unfold around you"
                onClick={(event) => {
                  if (event.target !== event.currentTarget) return;
                  closeLandingJourneyModal();
                }}
              >
                <div className={styles.landingJourneyModal}>
                  <button
                    type="button"
                    className={styles.landingJourneyModalClose}
                    onClick={closeLandingJourneyModal}
                    aria-label="Close nearby stories"
                  >
                    <Image
                      src="/icons/x.svg"
                      alt=""
                      width={18}
                      height={18}
                      className={styles.landingJourneyModalCloseIcon}
                      aria-hidden="true"
                    />
                  </button>
                  <h2 className={styles.landingJourneyModalTitle}>Stories unfold around you</h2>
                  <div className={styles.landingJourneyModalBody}>
                    <p className={styles.landingJourneyModalSubtext}>
As you move, Wandrful suggests nearby places with stories.
You choose where to go — each stop shapes what unfolds next.                     </p>
                    <button
                      type="button"
                      onClick={() => {
                        void launchLandingAlongTheWay();
                      }}
                      className={`${styles.landingCtaButton} ${styles.startTourButton} ${styles.landingJourneyModalCta}`}
                      disabled={isStartingWalkDiscovery || isResolvingNearbyGeo}
                    >
                      {isStartingWalkDiscovery || isResolvingNearbyGeo ? "Starting nearby..." : "Get discovering"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>
        </main>
      )}

{/* banner UI inside the WALK section
*/}
{(step === "walk" || step === "followAlongDrive") &&
 currentStop &&
 geoAllowed === true &&
 proximity !== "far" &&
 distanceToStopM !== null && (
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
                <h2 className={`${styles.pickHeading} ${styles.pickHeadingBelowClose}`}>How should this feel?</h2>
                {!narratorSelectionIsCustomOnly && (
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
                )}
                {customNarratorEnabled && (narratorSelectionIsCustomOnly || selectedPersona === "custom") && (
                  <div className={styles.customNarratorPanel}>
                     
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
                      {customNarratorGuidance.length}/{CUSTOM_NARRATOR_MAX_CHARS}
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
                    Choose your mix in{" "} 
                      {selectedCityLabel}
                     
                  </h2>
                </div>

                <div className={styles.pickRouteCardGrid}>
                  {routesForSelectedCity.map((r) => {
                    const isRoutePending = pendingPresetRouteAction?.routeId === r.id;
                    const pricingLabel = getRoutePricingLabel(r.pricing);
                    const stopCountLabel = formatStopCount(getPresetRouteSummaryStopCount(r));
                    const narratorLabel = getPresetRouteNarratorLabel(r);

                    return (
                    <div key={r.id} className={styles.pickRouteCardShell}>
                      <button
                        type="button"
                        onClick={() => {
                          startTourFromRoute(r.id);
                        }}
                        disabled={isRoutePending}
                        className={`${styles.pickRouteCard} ${selectedRouteId === r.id ? styles.pickRouteCardSelected : ""} ${isRoutePending ? styles.pickRouteCardPending : ""}`}
                        style={{ backgroundImage: `url("${getLandingRouteImage(r)}")` }}
                      >
                        <div className={styles.pickRouteCardOverlay} aria-hidden="true" />
                        <div className={styles.landingFeaturedCardPricePill} aria-hidden="true">
                          {pricingLabel}
                        </div>
                        <div className={styles.pickRouteCardContent}>
                          <div className={styles.pickRouteCardSpacer} aria-hidden="true" />
                          <div className={styles.pickRouteCardTitleWrap}>
                            <div className={`${styles.pickRouteCardTitle} ${getLandingTitleStyleClass(r.id)} ${getLandingTitleFontClass(r.id)}`}>
                              {r.title}
                            </div>
                          </div>
                          <div className={styles.pickRouteCardMeta}>
                            <div className={styles.pickRouteCardBadge} aria-hidden="true">
                              <Image
                                src={getPresetRouteIcon()}
                                alt=""
                                width={18}
                                height={18}
                                className={styles.pickRouteCardBadgeIcon}
                                aria-hidden="true"
                              />
                            </div>
                            <div className={styles.pickRouteCardMetaText}>
                              <div className={styles.pickRouteCardMetaPrimary}>Story by {narratorLabel}</div>
                              <div className={styles.pickRouteCardMetaSecondary}>
                                {r.durationLabel} • {stopCountLabel}
                              </div>
                            </div>
                          </div>
                        </div>
                      </button>
                    </div>
                    );
                  })}
                </div>
                <div className={styles.pickRouteActionList}>
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
                {selectedRoute && selectedPersona && (
                  <div className={`${styles.pickDurationStartWrap} ${styles.buildMixStickyCtaWrap} ${styles.buildMixStickyCtaEnter}`}>
                    <div className={styles.pickRouteStickyCtaContent}>
                      <div className={styles.pickRouteStickyCtaTitle}>{selectedRoute.title}</div>
                      <div className={styles.pickRouteStickyCtaPricePill}>
                        {getRoutePricingLabel(selectedRoute.pricing)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setErr(null);
                        setNarratorFlowSource(null);
                        setPickDurationPage("narrator");
                      }}
                      disabled={Boolean(pendingPresetRouteAction)}
                      className={`${styles.landingCtaButton} ${styles.startTourButton}`}
                    >
                      Start
                    </button>
                  </div>
                )}
              </section>

              <section className={styles.pickImagePane}>
                <RouteMap
                  stops={[]}
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
              <h2 className={styles.pickHeading}>Create your journey</h2>
            </div>

            <div className={`${styles.pickSectionLabel} ${styles.buildMixSummaryLabel}`}>
              {builderSelectedStops.length} of {maxStopsForSelection || 0} stops selected for {formatRouteMiles(selectedStopsDistanceMiles)}
            </div>
            <div className={styles.pickRouteList}>
              {builderSelectedStops.length === 0 ? (
                null
              ) : (
                builderSelectedStops.map((stop, idx) => {
                  const stopCoordKey = getStopCoordKey(stop);
                  const active = builderSelectedStops.some(
                    (s) => s.id === stop.id || getStopCoordKey(s) === stopCoordKey
                  );
                  const isFirst = idx === 0;
                  const isLast = idx === builderSelectedStops.length - 1;
                  return (
                    <div
                      key={stop.id}
                      className={`${styles.pickRouteRow} ${styles.pickRouteRowBuildMix} ${styles.buildMixStopCard} ${active ? styles.pickRouteRowSelected : ""}`}
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
                        className={
                          active
                            ? `${styles.pickRouteToggleButton} ${styles.buildMixStopActionButton} ${styles.walkDiscoverySkipButton}`
                            : `${styles.pickRouteToggleButton} ${styles.buildMixStopActionButton}`
                        }
                        onClick={() => toggleBuilderStop(stop)}
                        aria-label={active ? `Remove ${stop.title}` : `Add ${stop.title}`}
                      >
                        {active ? (
                          <Image
                            src="/icons/x.svg"
                            alt=""
                            width={18}
                            height={18}
                            className={styles.walkDiscoverySkipIcon}
                            aria-hidden="true"
                          />
                        ) : (
                          <div className={`${styles.pickRouteArrow} ${styles.buildMixStopAction}`}>
                            <div className={`${styles.pickRouteIconCircle} ${styles.buildMixStopActionCircle}`} aria-hidden="true">
                              <svg viewBox="0 0 16 16" className={styles.buildMixPlusIcon} aria-hidden="true">
                                <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4" fill="currentColor" />
                              </svg>
                            </div>
                          </div>
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            <div className={`${styles.buildMixLinkAddWrap} ${styles.buildMixSearchPanel}`}>
              <div className={`${styles.buildMixSearchRow} ${styles.buildMixSearchRowPanel}`}>
                <div className={`${styles.pickRouteTitle} ${styles.buildMixSearchPanelTitle}`}>Add a stop</div>
                <div className={`${styles.buildMixSearchInputWrap} ${styles.buildMixSearchInputWrapPanel}`}>
                  <button
                    type="button"
                    onClick={searchPlaces}
                    disabled={isSearchingPlaces}
                    className={`${styles.buildMixSearchActionButton} ${styles.buildMixSearchActionButtonPanel} ${styles.buildMixSearchActionButtonLeading}`}
                    aria-label={isSearchingPlaces ? "Searching places" : "Search places"}
                  >
                    <svg viewBox="0 0 24 24" className={styles.buildMixSearchIcon} aria-hidden="true">
                      <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
                      <line x1="16.2" y1="16.2" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                  <div className={styles.buildMixSearchInputShell}>
                    <input
                      type="text"
                      value={searchInput}
                      onChange={(e) => setSearchInput(e.target.value)}
                      onKeyDown={handleBuildMixSearchKeyDown}
                      enterKeyHint="search"
                      className={`${styles.buildMixSearchInput} ${styles.buildMixSearchInputPanel}`}
                      placeholder={`Where do you want to go?`}
                      aria-label="Search places"
                    />
                    <div className={`${styles.buildMixSearchActions} ${styles.buildMixSearchActionsPanel}`}>
                      <button
                        type="button"
                        onClick={clearBuildMixSearch}
                        className={`${styles.buildMixSearchActionButton} ${styles.buildMixSearchActionButtonPanel}`}
                        aria-label="Clear search"
                      >
                        <svg viewBox="0 0 24 24" className={styles.buildMixSearchClearIcon} aria-hidden="true">
                          <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                          <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              {searchError && <div className={`${styles.buildMixSearchError} ${styles.buildMixSearchPanelError}`}>{searchError}</div>}
              {searchInput.trim().length > 0 && availableSearchCandidates.length > 0 && (
                <div className={`${styles.buildMixSearchDropdown} ${styles.buildMixSearchDropdownLight}`}>
                  {availableSearchCandidates.map((candidate) => (
                    <div
                      key={candidate.id}
                      className={`${styles.buildMixSearchDropdownRow} ${styles.buildMixSearchDropdownRowLight}`}
                    >
                      <div className={styles.buildMixSearchDropdownTitle}>{candidate.title}</div>
                      <button
                        type="button"
                        onClick={() => addSearchedCandidate(candidate)}
                        className={`${styles.pickRouteToggleButton} ${styles.buildMixStopActionButton}`}
                        aria-label={`Add ${candidate.title}`}
                      >
                        <div className={`${styles.pickRouteArrow} ${styles.buildMixStopAction}`}>
                          <div className={`${styles.pickRouteIconCircle} ${styles.buildMixStopActionCircleLight}`} aria-hidden="true">
                            <svg viewBox="0 0 16 16" className={styles.buildMixPlusIcon} aria-hidden="true">
                              <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4" fill="currentColor" />
                            </svg>
                          </div>
                        </div>
                      </button>
                    </div>
                  ))}
                </div>
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
                    setSelectedPersona("custom");
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
              <h2 className={styles.pickHeading}>Wander</h2>
              <p className={styles.followAlongLead}>
                Stories appear as you travel to your destination.
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
                  setSelectedPersona("custom");
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
        <>
          <WalkScreen
            mode="interactive"
            map={(
              <RouteMap
                stops={route.stops}
                currentStopIndex={currentStopIndex ?? -1}
                myPos={myPos}
                initialFitRoute
                showRoutePath
                routeTravelMode="walk"
              />
            )}
            backControl={(
              <button onClick={goHome} className={walkStyles.mapBackButton} aria-label="Close">
                <Image
                  src="/icons/x.svg"
                  alt=""
                  width={26}
                  height={26}
                  className={walkStyles.mapBackIcon}
                  aria-hidden="true"
                />
              </button>
            )}
            mapAction={(
              <a href={mapsUrl} target="_blank" rel="noreferrer" className={walkStyles.mapViewButton}>
                View Directions
              </a>
            )}
            metaRow={(
              <>
                {isPresetWalkRoute ? (
                  <>
                    <div className={walkStyles.walkNarratorAvatarWrap}>
                      {usesNarratorIcon(persona) ? (
                        <Image
                          src="/icons/stars.svg"
                          alt=""
                          width={22}
                          height={22}
                          className={walkStyles.walkNarratorIcon}
                          aria-hidden="true"
                        />
                      ) : (
                        <Image
                          src={personaCatalog[persona].avatarSrc}
                          alt={personaCatalog[persona].avatarAlt}
                          fill
                          className={walkStyles.walkNarratorAvatar}
                        />
                      )}
                    </div>
                    <div className={walkStyles.walkNarrator}>
                      Story by <span className={walkStyles.walkNarratorActiveName}>{activePersonaDisplayName}</span>
                    </div>
                  </>
                ) : (
                  <>
                    {isSocialAttributedCustomRoute ? (
                      <>
                        {instagramStoryByUrl ? (
                          <a
                            href={instagramStoryByUrl}
                            target="_blank"
                            rel="noreferrer"
                            className={walkStyles.walkNarratorAvatarWrap}
                            aria-label={`Open ${instagramStoryByLabel} on Instagram`}
                          >
                            {shouldShowInstagramStoryAvatar ? (
                              <Image
                                src={instagramStoryByAvatarUrl || DEFAULT_STOP_IMAGE}
                                alt={`${instagramStoryByLabel} avatar`}
                                fill
                                unoptimized
                                className={walkStyles.walkNarratorAvatar}
                                onError={() => setDidInstagramAvatarFail(true)}
                              />
                            ) : (
                              <Image
                                src="/icons/stars.svg"
                                alt=""
                                width={22}
                                height={22}
                                className={walkStyles.walkNarratorIcon}
                                aria-hidden="true"
                              />
                            )}
                          </a>
                        ) : (
                          <div className={walkStyles.walkNarratorAvatarWrap}>
                            {shouldShowInstagramStoryAvatar ? (
                              <Image
                                src={instagramStoryByAvatarUrl || DEFAULT_STOP_IMAGE}
                                alt={`${instagramStoryByLabel} avatar`}
                                fill
                                unoptimized
                                className={walkStyles.walkNarratorAvatar}
                                onError={() => setDidInstagramAvatarFail(true)}
                              />
                            ) : (
                              <Image
                                src="/icons/stars.svg"
                                alt=""
                                width={22}
                                height={22}
                                className={walkStyles.walkNarratorIcon}
                                aria-hidden="true"
                              />
                            )}
                          </div>
                        )}
                        <div className={walkStyles.walkNarrator}>
                          Story by{" "}
                          {instagramStoryByUrl ? (
                            <a
                              href={instagramStoryByUrl}
                              target="_blank"
                              rel="noreferrer"
                              className={walkStyles.walkNarratorActiveName}
                            >
                              {instagramStoryByLabel}
                            </a>
                          ) : (
                            <span className={walkStyles.walkNarratorActiveName}>{instagramStoryByLabel}</span>
                          )}
                          <span className={walkStyles.walkNarratorRemixPill}>AI Remix</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={`${walkStyles.walkNarratorAvatarWrap} ${walkStyles.walkNarratorAvatarButton}`}
                          onClick={() => {
                            setReturnToWalkOnClose(true);
                            if (!isPresetWalkRoute) setSelectedPersona("custom");
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
                              className={walkStyles.walkNarratorIcon}
                              aria-hidden="true"
                            />
                          ) : (
                            <Image
                              src={personaCatalog[persona].avatarSrc}
                              alt={personaCatalog[persona].avatarAlt}
                              fill
                              className={walkStyles.walkNarratorAvatar}
                            />
                          )}
                        </button>
                        <button
                          className={`${walkStyles.walkNarrator} ${walkStyles.walkNarratorButton}`}
                          type="button"
                          onClick={() => {
                            setReturnToWalkOnClose(true);
                            if (!isPresetWalkRoute) setSelectedPersona("custom");
                            setNarratorFlowSource("walkEdit");
                            setPickDurationPage("narrator");
                            setStep("pickDuration");
                          }}
                        >
                          Narrated by <span className={walkStyles.walkNarratorActiveName}>{activePersonaDisplayName}</span>
                        </button>
                      </>
                    )}
                  </>
                )}
              </>
            )}
            title={route.title}
            subline={(
              <span>
                {displayListenerCount} {displayListenerCount === 1 ? "listener" : "listeners"} • {routeMilesLabel}
              </span>
            )}
            actions={(
              <>
                <button className={walkStyles.pillButton} type="button" onClick={copyShareLink}>Share</button>

                {activeInstagramCustomRouteId ? (
                  <button
                    className={walkStyles.pillButton}
                    type="button"
                    onClick={() => {
                      router.push(`/import/instagram?route=${encodeURIComponent(activeInstagramCustomRouteId)}`);
                    }}
                  >
                    Edit (IG)
                  </button>
                ) : null}

                {activePresetWalkRouteId && showPresetWalkRefresh && (
                  <button
                    className={walkStyles.pillButton}
                    type="button"
                    onClick={() => {
                      void regeneratePresetRoute(activePresetWalkRouteId);
                    }}
                    disabled={isActivePresetWalkRegenerating}
                    aria-label={`Regenerate ${route.title} with latest guidance`}
                  >
                    {isActivePresetWalkRegenerating ? "Regenerating..." : "Refresh"}
                  </button>
                )}

                {!activeInstagramCustomRouteId ? (
                  <button
                    className={walkStyles.pillButton}
                    type="button"
                    onClick={openEditStopsFromWalk}
                  >
                    Edit
                  </button>
                ) : null}
                <button
                  className={walkStyles.nowPlayingButton}
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
                    className={walkStyles.nowPlayingIcon}
                    aria-hidden="true"
                  />
                </button>
              </>
            )}
            stops={stopList.map((stop, idx) => ({
              id: stop.id,
              title: `${idx + 1}. ${stop.title}`,
              subtitle: stop.subtitle,
              imageSrc: stop.image,
              sourceLabel: stop.sourceLabel,
              isActive: stop.isActive,
              onSelect: () => void handleStopSelect(idx, { autoPlay: currentStopIndex !== idx }),
              ariaLabel: `Open ${stop.title}`,
            }))}
            afterStops={
              isWalkDiscoveryRoute && (walkDiscoverySuggestion || isResolvingWalkDiscoverySuggestion) ? (
                <div className={styles.walkDiscoveryPanel}>
                  <div className={styles.walkDiscoveryCard}>
                    {walkDiscoverySuggestion ? (
                      <div className={styles.walkDiscoveryContent}>
                        <div className={styles.walkDiscoveryTopRow}>
                          <div className={styles.walkDiscoveryImageWrap}>
                            <WalkStepImage
                              src={toSafeStopImage(walkDiscoverySuggestion.image)}
                              alt={walkDiscoverySuggestion.title}
                              fill
                              className={styles.walkDiscoveryImage}
                              unoptimized
                            />
                          </div>
                          <div className={styles.walkDiscoveryBody}>
                            <div className={styles.walkDiscoveryEyebrow}>Suggested Stop</div>
                            <div className={styles.walkDiscoveryTitle}>
                              {walkDiscoverySuggestion.title}
                            </div>
                            <div className={styles.walkDiscoveryMetaRow}>
                              <div className={styles.walkDiscoveryPriceBadge}>
                                {walkDiscoverySuggestion.isIncluded
                                  ? "Included"
                                  : walkDiscoverySuggestion.isFree
                                    ? "Free"
                                    : `Add for ${walkDiscoverySuggestion.priceLabel}`}
                              </div>
                              {typeof walkDiscoverySuggestion.distanceMeters === "number" ? (
                                <div className={styles.walkDiscoveryDistance}>
                                  {formatDistance(walkDiscoverySuggestion.distanceMeters)} away
                                </div>
                              ) : null}
                            </div>
                          </div>
                          <button
                            type="button"
                            className={styles.walkDiscoverySkipButton}
                            onClick={() => void rejectWalkDiscoverySuggestion()}
                            disabled={isAcceptingWalkDiscoverySuggestion || isCompletingWalkDiscoveryCheckout}
                            aria-label="Skip suggested stop"
                          >
                            <Image
                              src="/icons/x.svg"
                              alt=""
                              width={18}
                              height={18}
                              className={styles.walkDiscoverySkipIcon}
                              aria-hidden="true"
                            />
                          </button>
                        </div>
                        <button
                          type="button"
                          className={styles.walkDiscoveryAddButton}
                          onClick={() => void acceptWalkDiscoverySuggestion()}
                          disabled={isAcceptingWalkDiscoverySuggestion || isCompletingWalkDiscoveryCheckout}
                          aria-label={
                            isAcceptingWalkDiscoverySuggestion || isCompletingWalkDiscoveryCheckout
                              ? "Adding suggested stop"
                              : walkDiscoverySuggestion.isIncluded
                                ? "Add included suggested stop"
                                : walkDiscoverySuggestion.isFree
                                  ? "Add free suggested stop"
                                  : `Add suggested stop for ${walkDiscoverySuggestion.priceLabel}`
                          }
                        >
                          {isAcceptingWalkDiscoverySuggestion || isCompletingWalkDiscoveryCheckout
                            ? "Adding..."
                            : walkDiscoverySuggestion.isIncluded
                              ? "Add"
                              : walkDiscoverySuggestion.isFree
                                ? "Add for free"
                                : `Add for ${walkDiscoverySuggestion.priceLabel}`}
                        </button>
                      </div>
                    ) : (
                      <div className={styles.walkDiscoveryLoading}>
                        Looking for your next nearby story...
                      </div>
                    )}
                  </div>
                </div>
              ) : null
            }
            nowPlayingBar={
              currentStop ? (
                <div className={walkStyles.nowPlayingBar}>
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
                  <div className={`${walkStyles.nowPlayingContent} ${walkStyles.nowPlayingContentEnter}`}>
                    <div className={walkStyles.nowPlayingMetaGroup}>
                      <button
                        type="button"
                        className={walkStyles.nowPlayingMetaButton}
                        onClick={openScriptModal}
                      >
                        <div className={walkStyles.nowPlayingThumbWrap}>
                          <WalkStepImage
                            src={toSafeStopImage(currentStop.images[0])}
                            alt={currentStop.title}
                            fill
                            className={walkStyles.nowPlayingThumb}
                            unoptimized
                          />
                        </div>
                        <div className={walkStyles.nowPlayingMeta}>
                          <div className={walkStyles.nowPlayingTitleText}>{currentStop.title}</div>
                          <div className={walkStyles.nowPlayingSubtitle}>
                            {isGeneratingScriptForModal
                              ? "Generating script..."
                              : isGeneratingAudioForCurrentStop
                                ? "Generating audio..."
                                : hasCurrentAudio
                                  ? `${formatAudioTime(audioTime)} / ${formatAudioTime(audioDuration)}`
                                  : "Audio not generated yet"}
                          </div>
                          {currentStopSourceLabel ? (
                            <div className={walkStyles.nowPlayingSourceMeta}>{currentStopSourceLabel}</div>
                          ) : null}
                        </div>
                      </button>
                      {hasCurrentAudio ? (
                        <a
                          className={walkStyles.nowPlayingInlineLink}
                          href={currentStopAudio}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View audio
                        </a>
                      ) : null}
                    </div>
                    <button
                      className={`${walkStyles.nowPlayingButton} ${walkStyles.nowPlayingBarButton}`}
                      onClick={toggleAudio}
                      disabled={!hasCurrentAudio}
                      aria-label={isPlaying ? "Pause current stop" : "Play current stop"}
                    >
                      <Image
                        src={isPlaying ? "/icons/pause-fill.svg" : "/icons/play-fill.svg"}
                        alt=""
                        width={28}
                        height={28}
                        className={`${walkStyles.nowPlayingIcon} ${walkStyles.nowPlayingBarIcon}`}
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                </div>
              ) : null
            }
          />
            {(walkDiscoveryCheckoutSuggestion || isStartingWalkDiscoveryCheckout || isCompletingWalkDiscoveryCheckout) && (
              <div
                className={styles.walkDiscoveryCheckoutOverlay}
                role="dialog"
                aria-modal="true"
                aria-label="Add a Wander stop"
                onClick={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (isStartingWalkDiscoveryCheckout || isCompletingWalkDiscoveryCheckout) return;
                  setWalkDiscoveryCheckoutSuggestion(null);
                  setWalkDiscoveryMagicLinkMessage(null);
                }}
              >
                <div className={styles.walkDiscoveryCheckoutSheet}>
                  {!isStartingWalkDiscoveryCheckout && !isCompletingWalkDiscoveryCheckout && walkDiscoveryCheckoutSuggestion ? (
                    <>
                      <button
                        type="button"
                        className={styles.walkDiscoveryCheckoutClose}
                        onClick={() => {
                          setWalkDiscoveryCheckoutSuggestion(null);
                          setWalkDiscoveryMagicLinkMessage(null);
                        }}
                        aria-label="Close paid stop checkout"
                      >
                        <Image
                          src="/icons/x.svg"
                          alt=""
                          width={16}
                          height={16}
                          className={styles.walkDiscoveryCheckoutCloseIcon}
                          aria-hidden="true"
                        />
                      </button>
                      <div className={styles.walkDiscoveryCheckoutHeader}>
                        <div className={styles.walkDiscoveryCheckoutImageWrap}>
                          <WalkStepImage
                            src={toSafeStopImage(walkDiscoveryCheckoutSuggestion.image)}
                            alt={walkDiscoveryCheckoutSuggestion.title}
                            fill
                            className={styles.walkDiscoveryCheckoutImage}
                            unoptimized
                          />
                        </div>
                        <div className={styles.walkDiscoveryCheckoutHeaderBody}>
                          <div className={styles.walkDiscoveryCheckoutEyebrow}>
                            {authUserEmail ? "Extra Wander stop" : "Sign in to continue"}
                          </div>
                          <div className={styles.walkDiscoveryCheckoutTitle}>
                            {walkDiscoveryCheckoutSuggestion.title}
                          </div>
                          {typeof walkDiscoveryCheckoutSuggestion.distanceMeters === "number" ? (
                            <div className={styles.walkDiscoveryCheckoutDistance}>
                              {formatDistance(walkDiscoveryCheckoutSuggestion.distanceMeters)} away
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <p className={styles.walkDiscoveryCheckoutText}>
                        This adds one more story stop to your Wander.
                      </p>
                      <div className={styles.walkDiscoveryCheckoutPriceRow}>
                        <span>1 extra stop</span>
                        <strong>{walkDiscoveryCheckoutSuggestion.priceLabel}</strong>
                      </div>
                      {authUserEmail ? (
                        <p className={styles.walkDiscoveryCheckoutSignedIn}>
                          Signed in as {authUserEmail}.
                        </p>
                      ) : (
                        <>
                          <p className={styles.walkDiscoveryCheckoutText}>
                            Sign in first so we can attach this paid stop to your account.
                          </p>
                          <label className={styles.walkDiscoveryCheckoutLabel} htmlFor="walk-discovery-email">
                            Email address
                            <input
                              id="walk-discovery-email"
                              type="email"
                              value={walkDiscoveryMagicLinkEmail}
                              onChange={(event) => setWalkDiscoveryMagicLinkEmail(event.target.value)}
                              placeholder="you@example.com"
                              autoComplete="email"
                              disabled={isSendingWalkDiscoveryMagicLink}
                              className={styles.walkDiscoveryCheckoutInput}
                            />
                          </label>
                        </>
                      )}
                      {walkDiscoveryMagicLinkMessage ? (
                        <div className={styles.walkDiscoveryCheckoutMessage}>
                          {walkDiscoveryMagicLinkMessage}
                        </div>
                      ) : null}
                      <div className={styles.walkDiscoveryCheckoutActions}>
                        {authUserEmail ? (
                          <button
                            type="button"
                            className={styles.walkDiscoveryCheckoutPrimary}
                            onClick={() => void startWalkDiscoveryCheckout(walkDiscoveryCheckoutSuggestion)}
                            disabled={isStartingWalkDiscoveryCheckout}
                          >
                            {isStartingWalkDiscoveryCheckout ? "Opening secure checkout..." : "Continue to secure checkout"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={styles.walkDiscoveryCheckoutPrimary}
                            onClick={() => void sendWalkDiscoveryMagicLink()}
                            disabled={isSendingWalkDiscoveryMagicLink}
                          >
                            {isSendingWalkDiscoveryMagicLink ? "Sending sign-in link..." : "Email me a sign-in link"}
                          </button>
                        )}
                        <button
                          type="button"
                          className={styles.walkDiscoveryCheckoutSecondary}
                          onClick={() => {
                            setWalkDiscoveryCheckoutSuggestion(null);
                            setWalkDiscoveryMagicLinkMessage(null);
                          }}
                          disabled={isSendingWalkDiscoveryMagicLink || isStartingWalkDiscoveryCheckout}
                        >
                          Not now
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className={styles.walkDiscoveryCheckoutPending}>
                      <p className={styles.walkDiscoveryCheckoutPendingTitle}>
                        {isCompletingWalkDiscoveryCheckout ? "Adding paid stop" : "Opening secure checkout"}
                      </p>
                      <p className={styles.walkDiscoveryCheckoutPendingText}>
                        {isCompletingWalkDiscoveryCheckout
                          ? "Finalizing your payment and adding this stop to Wander."
                          : "We&apos;re taking you to our hosted payment screen now."}
                      </p>
                    </div>
                  )}
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
                    <WalkStepImage
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
        </>
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

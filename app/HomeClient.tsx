"use client";
 
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { supabase } from "@/lib/supabaseClient";
import { getRouteById, salemRoutes, type Persona, type RouteDef } from "@/app/content/salemRoutes";
import { personaCatalog } from "@/lib/personas/catalog";
import { getMaxStops, validateMixSelection } from "@/lib/mixConstraints";
import dynamic from "next/dynamic";
import styles from "./HomeClient.module.css";

const RouteMap = dynamic(() => import("./components/RouteMap"), { ssr: false });



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
};

type FlowStep = "landing" | "pickDuration" | "buildMix" | "generating" | "walk" | "end";
type CityOption = "salem" | "boston" | "concord";
type TransportMode = "walk" | "drive";

type CustomMixStop = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  image: string;
};

type CustomRouteResponse = {
  route: {
    id: string;
    title: string;
    length_minutes: number;
    transport_mode: TransportMode;
    status: "queued" | "generating" | "generating_script" | "generating_audio" | "ready" | "ready_with_warnings" | "failed";
  };
  stops: Array<{
    stop_id: string;
    title: string;
    lat: number;
    lng: number;
    image_url: string | null;
    script_adult: string | null;
    script_preteen: string | null;
    audio_url_adult: string | null;
    audio_url_preteen: string | null;
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
};

type GenerationJobKind = "custom" | "preset";

type ResolveLinksResponse = {
  resolved: CustomMixStop[];
  failed: Array<{ input: string; reason: string }>;
  duplicatesSkipped: number;
};

type ResolveSummary = {
  added: number;
  skippedDuplicate: number;
  skippedLimit: number;
  failed: Array<{ input: string; reason: string }>;
};

const GENERATION_STATUS_LABELS: Record<MixJobResponse["status"], string> = {
  queued: "Queued",
  generating_script: "Creating the curated story",
  generating_audio: "Recording the audio",
  ready: "Ready",
  ready_with_warnings: "Ready with warnings",
  failed: "Failed",
};

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

function getRouteMiles(stops: RouteDef["stops"]) {
  if (stops.length < 2) return 0;
  let totalMeters = 0;
  for (let i = 1; i < stops.length; i += 1) {
    totalMeters += haversineMeters(stops[i - 1].lat, stops[i - 1].lng, stops[i].lat, stops[i].lng);
  }
  return totalMeters / 1609.344;
}

function formatRouteMiles(miles: number) {
  return `${miles.toFixed(miles < 1 ? 2 : 1)} mi`;
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

export default function HomeClient() {
  const [distanceToStopM, setDistanceToStopM] = useState<number | null>(null);
const [proximity, setProximity] = useState<"far" | "near" | "arrived">("far");
const audioRef = useRef<HTMLAudioElement | null>(null);
const [isPlaying, setIsPlaying] = useState(false);
const [audioTime, setAudioTime] = useState(0);
const [audioDuration, setAudioDuration] = useState(0);
const [connectedCount, setConnectedCount] = useState(0);
const [selectedRouteId, setSelectedRouteId] = useState<RouteDef["id"] | null>(null);
const [selectedPersona, setSelectedPersona] = useState<Persona | null>(null);
const [selectedCity, setSelectedCity] = useState<CityOption>("salem");
const [transportMode, setTransportMode] = useState<TransportMode>("walk");
const [selectedLengthMinutes, setSelectedLengthMinutes] = useState<number>(30);
const [builderSelectedStops, setBuilderSelectedStops] = useState<CustomMixStop[]>([]);
const [linkBatchInput, setLinkBatchInput] = useState("");
const [isResolvingLinks, setIsResolvingLinks] = useState(false);
const [resolveSummary, setResolveSummary] = useState<ResolveSummary | null>(null);
const [isGeneratingMix, setIsGeneratingMix] = useState(false);
const [generationJobId, setGenerationJobId] = useState<string | null>(null);
const [generationJobKind, setGenerationJobKind] = useState<GenerationJobKind | null>(null);
const [generationProgress, setGenerationProgress] = useState(0);
const [generationStatusLabel, setGenerationStatusLabel] = useState(GENERATION_STATUS_LABELS.queued);
const [generationMessage, setGenerationMessage] = useState("Queued");
const [customRoute, setCustomRoute] = useState<RouteDef | null>(null);
const [isScriptModalOpen, setIsScriptModalOpen] = useState(false);
const [isGeneratingScriptForModal, setIsGeneratingScriptForModal] = useState(false);
const [isGeneratingAudioForCurrentStop, setIsGeneratingAudioForCurrentStop] = useState(false);
const [returnToWalkOnClose, setReturnToWalkOnClose] = useState(false);
const [activeStopIndex, setActiveStopIndex] = useState<number | null>(null);
const [pendingAutoplayStopId, setPendingAutoplayStopId] = useState<string | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();

  const [err, setErr] = useState<string | null>(null);
  const [jam, setJam] = useState<JamRow | null>(null);

  const [step, setStep] = useState<FlowStep>("landing");

  // For MVP: Salem-only. This just controls whether we use geolocation-derived distances.
  const [geoAllowed, setGeoAllowed] = useState<boolean | null>(null);
  const [myPos, setMyPos] = useState<{ lat: number; lng: number } | null>(null);

  const jamIdFromUrl = searchParams.get("jam");
  const debugStepFromUrl = searchParams.get("debugStep");

  // Derive route + stop from jam
  const route: RouteDef | null = useMemo(
    () => customRoute ?? getRouteById(jam?.route_id ?? null),
    [customRoute, jam?.route_id]
  );
  const persona: Persona = (jam?.persona ?? "adult") as Persona;

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
  const routeMilesLabel = useMemo(() => {
    if (!route) return "";
    return formatRouteMiles(getRouteMiles(route.stops));
  }, [route]);
  const selectedRoute = useMemo(
    () => (selectedRouteId ? salemRoutes.find((r) => r.id === selectedRouteId) ?? null : null),
    [selectedRouteId]
  );
  const selectedCityLabel = useMemo(
    () => (selectedCity === "salem" ? "Salem" : selectedCity === "boston" ? "Boston" : "Concord"),
    [selectedCity]
  );
  const selectedCityCenter = useMemo(
    () =>
      selectedCity === "salem"
        ? { lat: 42.5195, lng: -70.8967 }
        : selectedCity === "boston"
          ? { lat: 42.3601, lng: -71.0589 }
          : { lat: 42.4604, lng: -71.3489 },
    [selectedCity]
  );
  const availableStopsForCity = useMemo<CustomMixStop[]>(() => {
    if (selectedCity !== "salem") return [];
    const byId = new Map<string, CustomMixStop>();
    for (const r of salemRoutes) {
      for (const s of r.stops) {
        if (byId.has(s.id)) continue;
        byId.set(s.id, {
          id: s.id,
          title: s.title,
          lat: s.lat,
          lng: s.lng,
          image: s.images[0] ?? "/images/salem/placeholder-01.png",
        });
      }
    }
    return Array.from(byId.values());
  }, [selectedCity]);
  const buildMixDisplayStops = useMemo<CustomMixStop[]>(() => {
    const merged: CustomMixStop[] = [];
    const seen = new Set<string>();

    for (const stop of builderSelectedStops) {
      const key = stop.id || getStopCoordKey(stop);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(stop);
    }

    for (const stop of availableStopsForCity) {
      const idKey = stop.id;
      const coordKey = getStopCoordKey(stop);
      if (seen.has(idKey) || seen.has(coordKey)) continue;
      seen.add(idKey);
      seen.add(coordKey);
      merged.push(stop);
    }

    return merged;
  }, [availableStopsForCity, builderSelectedStops]);
  const activePersonaDisplayName = personaCatalog[persona].displayName;
  const maxStopsForSelection = useMemo(
    () => getMaxStops(selectedLengthMinutes, transportMode),
    [selectedLengthMinutes, transportMode]
  );
  const selectionValidation = useMemo(
    () => validateMixSelection(selectedLengthMinutes, transportMode, builderSelectedStops.length),
    [selectedLengthMinutes, transportMode, builderSelectedStops.length]
  );

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

    // Decide which screen we’re on
    if (!data.route_id) setStep("pickDuration");
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

    // Put it in URL like your existing flow
    router.replace(`/?jam=${data.id}`);

    if (!opts?.skipStep) {
      if (!routeId) setStep("pickDuration");
      else setStep("walk");
    }
    return data.id as string;
  }

  // ---------- Supabase: update jam ----------
  async function updateJam(patch: Partial<JamRow>) {
    if (!jam) return;
    setErr(null);

    const { data, error } = await supabase
      .from("jams")
      .update(patch)
      .eq("id", jam.id)
      .select("id,host_name,route_id,persona,current_stop,completed_at,is_playing,position_ms")
      .single();

    if (error) return setErr(error.message);
    setJam(data as JamRow);
  }

  async function copyShareLink() {
    if (!jam) return;
    await navigator.clipboard?.writeText(`${window.location.origin}/?jam=${jam.id}`);
  }

  function goHome() {
    router.replace("/");
    setJam(null);
    setCustomRoute(null);
    setGenerationJobId(null);
    setGenerationJobKind(null);
    setIsScriptModalOpen(false);
    setReturnToWalkOnClose(false);
    setStep("landing");
  }

  function closeRoutePicker() {
    if (returnToWalkOnClose && jam?.route_id) {
      setStep("walk");
      setReturnToWalkOnClose(false);
      return;
    }
    goHome();
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
      return;
    }
    const endpoint = isCustom ? `/api/custom-routes/${customRouteId}` : `/api/preset-routes/${routeRef}`;
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(`Failed to load ${isCustom ? "custom" : "preset"} route`);
    const payload = (await res.json()) as CustomRouteResponse;
    const nextRoute: RouteDef = {
      id: routeRef,
      title: payload.route.title,
      durationLabel: `${payload.route.length_minutes} min`,
      description: `${payload.route.transport_mode === "drive" ? "Drive" : "Walk"} • ${payload.stops.length} stops`,
      stops: payload.stops.map((s, idx) => ({
        id: s.stop_id || `custom-${idx}`,
        title: s.title,
        lat: s.lat,
        lng: s.lng,
        images: [s.image_url || "/images/salem/placeholder-01.png"],
        audio: {
          adult: s.audio_url_adult || "",
          preteen: s.audio_url_preteen || "",
        },
        text: {
          adult: s.script_adult || "",
          preteen: s.script_preteen || "",
        },
      })),
    };
    setCustomRoute(nextRoute);
  }, []);

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

  function seekAudio(nextTime: number) {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = nextTime;
    setAudioTime(nextTime);
  }

  async function openScriptModal() {
    if (!currentStop || !jam?.route_id) return;
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
            city: selectedCity,
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
            city: selectedCity,
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

  // ---------- Step transitions ----------

  async function startTourFromSelection() {
    if (!selectedRouteId || !selectedPersona) return;
    setReturnToWalkOnClose(false);
    setErr(null);
    setStep("generating");
    setGenerationProgress(0);
    setGenerationStatusLabel(GENERATION_STATUS_LABELS.queued);
    setGenerationMessage("Queued");

    let jamId = jam?.id ?? null;
    if (!jamId) {
      jamId = await createJam(selectedRouteId, selectedPersona, { skipStep: true });
      if (!jamId) {
        setStep("pickDuration");
        return;
      }
    } else {
      await updateJam({
        route_id: selectedRouteId,
        persona: selectedPersona,
        current_stop: 0,
        completed_at: null,
      });
    }

    try {
      const res = await fetch("/api/preset-jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jamId,
          routeId: selectedRouteId,
          persona: selectedPersona,
          city: selectedCity,
        }),
      });
      const body = (await res.json()) as { error?: string; jobId?: string };
      if (!res.ok || !body.jobId) throw new Error(body.error || "Failed to create preset generation job");
      setGenerationJobId(body.jobId);
      setGenerationJobKind("preset");
      router.replace(`/?jam=${jamId}`);
    } catch (e) {
      setGenerationJobKind(null);
      setErr(e instanceof Error ? e.message : "Failed to generate preset tour");
      setStep("pickDuration");
    }
  }

  function toggleBuilderStop(stop: CustomMixStop) {
    setErr(null);
    setBuilderSelectedStops((prev) => {
      const exists = prev.some((s) => s.id === stop.id);
      if (exists) return prev.filter((s) => s.id !== stop.id);
      const nextMaxStops = getMaxStops(selectedLengthMinutes, transportMode);
      if (nextMaxStops > 0 && prev.length >= nextMaxStops) {
        setErr(`Select at most ${nextMaxStops} stops for ${selectedLengthMinutes} min ${transportMode} tours.`);
        return prev;
      }
      return [...prev, stop];
    });
  }

  async function addStopsFromLinks() {
    const links = linkBatchInput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (!links.length) {
      setErr("Paste at least one Google Maps link.");
      return;
    }

    setErr(null);
    setResolveSummary(null);
    setIsResolvingLinks(true);

    try {
      const res = await fetch("/api/stops/resolve-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city: selectedCity, links }),
      });
      const body = (await res.json()) as ResolveLinksResponse | { error?: string };
      if (!res.ok || !("resolved" in body)) {
        throw new Error(("error" in body && body.error) || "Failed to resolve links");
      }

      const nextStops = [...builderSelectedStops];
      const selectedKeys = new Set(
        builderSelectedStops.map((s) => getStopCoordKey(s))
      );
      let added = 0;
      let skippedDuplicate = body.duplicatesSkipped;
      let skippedLimit = 0;

      for (const stop of body.resolved) {
        const key = getStopCoordKey(stop);
        if (selectedKeys.has(key)) {
          skippedDuplicate += 1;
          continue;
        }
        if (maxStopsForSelection > 0 && nextStops.length >= maxStopsForSelection) {
          skippedLimit += 1;
          continue;
        }
        selectedKeys.add(key);
        nextStops.push(stop);
        added += 1;
      }

      setBuilderSelectedStops(nextStops);
      setResolveSummary({
        added,
        skippedDuplicate,
        skippedLimit,
        failed: body.failed,
      });
      setLinkBatchInput("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to add stops from links");
    } finally {
      setIsResolvingLinks(false);
    }
  }

  async function startCustomMixGeneration() {
    if (!builderSelectedStops.length || !selectedPersona) return;
    const validation = validateMixSelection(selectedLengthMinutes, transportMode, builderSelectedStops.length);
    if (!validation.ok) {
      setErr(validation.message);
      return;
    }

    setErr(null);
    setIsGeneratingMix(true);
    setStep("generating");

    try {
      const res = await fetch("/api/mix-jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jamId: jam?.id ?? null,
          city: selectedCity,
          transportMode,
          lengthMinutes: selectedLengthMinutes,
          persona: selectedPersona,
          stops: builderSelectedStops,
        }),
      });
      const body = (await res.json()) as { error?: string; jamId?: string; jobId?: string };
      if (!res.ok) {
        throw new Error(body.error || "Failed to start mix generation");
      }
      if (!body.jamId || !body.jobId) {
        throw new Error("Missing generation job metadata");
      }
      setGenerationJobId(body.jobId);
      setGenerationJobKind("custom");
      setGenerationProgress(0);
      setGenerationStatusLabel(GENERATION_STATUS_LABELS.queued);
      setGenerationMessage("Queued");
      router.replace(`/?jam=${body.jamId}`);
    } catch (e) {
      setGenerationJobKind(null);
      setErr(e instanceof Error ? e.message : "Failed to generate custom mix");
      setStep("buildMix");
    } finally {
      setIsGeneratingMix(false);
    }
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
      setCustomRoute(null);
      setGenerationJobId(null);
      setGenerationJobKind(null);
      setStep("landing");
      return;
    }
    loadJamById(jamIdFromUrl);
  }, [jamIdFromUrl, debugStepFromUrl]);

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

    const poll = async () => {
      try {
        const endpoint =
          generationJobKind === "custom"
            ? `/api/mix-jobs/${generationJobId}`
            : `/api/preset-jobs/${generationJobId}`;
        const res = await fetch(endpoint, { cache: "no-store" });
        const body = (await res.json()) as MixJobResponse | { error?: string };
        if (!res.ok || !("status" in body)) {
          throw new Error(("error" in body && body.error) || "Failed to poll generation status");
        }
        if (cancelled) return;

        const nextProgress = Math.max(0, Math.min(100, Number(body.progress) || 0));
        setGenerationProgress(nextProgress);
        setGenerationStatusLabel(getGenerationStatusLabel(body.status));
        setGenerationMessage(body.message || "");

        if (body.status === "ready" || body.status === "ready_with_warnings") {
          setGenerationJobId(null);
          setGenerationJobKind(null);
          const routeRef = generationJobKind === "custom" ? `custom:${body.route_id}` : body.route_id;
          await loadResolvedRoute(routeRef);
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
        }
      } catch (e) {
        if (!cancelled) {
          setGenerationJobId(null);
          setGenerationJobKind(null);
          const message = e instanceof Error ? e.message : "Failed to poll generation status";
          setErr(message);
          setGenerationProgress(100);
          setGenerationStatusLabel(GENERATION_STATUS_LABELS.failed);
          setGenerationMessage(message);
        }
      }
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [step, generationJobId, generationJobKind, loadResolvedRoute]);

// ---------- watchPosition ----------
  useEffect(() => {
  if (step !== "walk") return;
  if (!navigator.geolocation) return;
  if (!currentStop) return;

  // If user never enabled geo, don't nag; banner will stay hidden.
  let watchId: number | null = null;

  try {
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const nextPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setMyPos(nextPos);
        setGeoAllowed(true);

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
    if (step !== "walk") return;
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
      const routeId = salemRoutes.some((r) => r.id === jam.route_id) ? jam.route_id : null;
      setSelectedRouteId(routeId);
      setSelectedPersona((jam.persona ?? null) as Persona | null);
      return;
    }
    setSelectedRouteId(null);
    setSelectedPersona(null);
  }, [step, returnToWalkOnClose, jam?.route_id, jam?.persona]);

  useEffect(() => {
    if (step !== "buildMix") return;
    setBuilderSelectedStops([]);
    setSelectedPersona("adult");
    setTransportMode("walk");
    setSelectedLengthMinutes(30);
    setGenerationJobId(null);
    setGenerationJobKind(null);
    setGenerationProgress(0);
    setGenerationStatusLabel(GENERATION_STATUS_LABELS.queued);
    setGenerationMessage("Queued");
  }, [step]);

  useEffect(() => {
    if (!jam?.id) {
      setConnectedCount(0);
      return;
    }

    const presenceKey =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
    const channel = supabase.channel(`jam:${jam.id}`, {
      config: { presence: { key: presenceKey } },
    });

    const updateConnectedCount = () => {
      const presence = channel.presenceState();
      const count = Object.keys(presence).length;
      setConnectedCount(Math.max(count, 1));
    };

    channel
      .on("presence", { event: "sync" }, updateConnectedCount)
      .on("presence", { event: "join" }, updateConnectedCount)
      .on("presence", { event: "leave" }, updateConnectedCount)
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED") return;
        await channel.track({ jam_id: jam.id, joined_at: new Date().toISOString() });
        updateConnectedCount();
      });

    return () => {
      void channel.untrack();
      void supabase.removeChannel(channel);
    };
  }, [jam?.id]);

  useEffect(() => {
    if (!["landing", "pickDuration", "buildMix", "generating", "walk"].includes(step)) return;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [step]);

  const stopList = useMemo(() => {
    if (!route) return [];
    const selectedIdx = currentStopIndex ?? -1;
    return route.stops.map((stop, idx) => {
      if (selectedIdx < 0) {
        return {
          id: stop.id,
          title: stop.title,
          image: stop.images[0] ?? "/images/salem/placeholder-01.png",
          subtitle: "Tap to start",
          isActive: false,
        };
      }

      let subtitle = "At this location";
      if (idx < selectedIdx) subtitle = "Visited";
      if (idx > selectedIdx) {
        const prev = route.stops[idx - 1];
        const meters = haversineMeters(prev.lat, prev.lng, stop.lat, stop.lng);
        subtitle = `${estimateWalkMinutes(meters)} min walk away`;
      }
      return {
        id: stop.id,
        title: stop.title,
        image: stop.images[0] ?? "/images/salem/placeholder-01.png",
        subtitle,
        isActive: idx === selectedIdx,
      };
    });
  }, [route, currentStopIndex]);

  const mapsUrl = useMemo(() => {
    if (!route || route.stops.length < 2) return "#";
    const origin = `${route.stops[0].lat},${route.stops[0].lng}`;
    const destination = `${route.stops[route.stops.length - 1].lat},${route.stops[route.stops.length - 1].lng}`;
    const waypoints = route.stops
      .slice(1, -1)
      .map((s) => `${s.lat},${s.lng}`)
      .join("|");
    const base = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=walking`;
    return waypoints ? `${base}&waypoints=${encodeURIComponent(waypoints)}` : base;
  }, [route]);

  // ---------- UI ----------
  return (
    <div className={`${styles.container} ${step === "walk" || step === "landing" || step === "pickDuration" || step === "buildMix" || step === "generating" ? styles.containerWide : ""}`}>
      {step !== "walk" && step !== "landing" && step !== "pickDuration" && step !== "buildMix" && step !== "generating" && (
        <header className={styles.header}>
          <div>
            <button type="button" onClick={goHome} className={`${styles.brandLink} ${styles.brandTitle}`}>MixTours</button>
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
        <main className={styles.landingLayout}>
          <section className={styles.landingInfo}>
            <button type="button" onClick={goHome} className={`${styles.brandLink} ${styles.landingBrand}`}>MixTours</button>
            <div className={styles.landingCopyBlock}>
              <h1 className={styles.landingHeading}>A mixtape for&nbsp;the&nbsp;streets.</h1>
              <p className={styles.landingCopy}>
               Wander with intention. Experience places through a curated lens. <strong>More story. Less directions.
              </strong></p>
            </div>

            <div className={styles.landingPopular}>Popular Tour Mixes:</div>

            <button
              className={styles.landingTourRow}
              type="button"
              onClick={() => {
                setSelectedCity("salem");
                setStep("pickDuration");
              }}
            >
              <div className={styles.landingTourText}>
                <div className={styles.landingTourTitle}>Salem</div>
                <div className={styles.landingTourSub}>Historic seaport, witch-trial legacy</div>
              </div>
              <Image
                src="/icons/chevron-right.svg"
                alt=""
                width={28}
                height={28}
                className={styles.landingArrowIcon}
                aria-hidden="true"
              />
            </button>

            <div className={styles.landingTourRowMuted}>
              <div className={styles.landingTourText}>
                <div className={styles.landingTourTitleMuted}>Boston</div>
                <div className={styles.landingTourSub}>Coming Soon...</div>
              </div>
            </div>
 

            <div className={styles.landingCtaWrap}>
              <button
                onClick={() => {
                  setSelectedCity("salem");
                  setStep("pickDuration");
                }}
                className={styles.landingCtaButton}
              >
                Create your own mix
              </button>
            </div>
          </section>

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
          <section className={`${styles.pickInfo} ${styles.pickInfoSelectRoute}`}>
            <button onClick={closeRoutePicker} className={`${styles.mapBackButton} ${styles.mapBackButtonInverted} ${styles.pickCloseButtonLeft} ${styles.pickCloseButtonDesktop}`} aria-label="Close">
              <Image
                src="/icons/x.svg"
                alt=""
                width={26}
                height={26}
                className={styles.mapBackIconDark}
                aria-hidden="true"
              />
            </button>
            <h2 className={`${styles.pickHeading} ${styles.pickHeadingBelowClose}`}>What narrator do you want?</h2>
            <div className={styles.pickPersonaRow}>
              <button
                onClick={() => setSelectedPersona("adult")}
                className={`${styles.pickNarratorOption} ${selectedPersona === "adult" ? styles.pickNarratorOptionSelected : ""}`}
              >
                <div className={styles.pickNarratorWithAvatar}>
                  <div className={styles.pickNarratorAvatarWrap}>
                    <Image
                      src={personaCatalog.adult.avatarSrc}
                      alt={personaCatalog.adult.avatarAlt}
                      fill
                      className={styles.pickNarratorAvatar}
                    />
                  </div>
                  <div>
                    <div className={styles.pickRouteTitle}>{personaCatalog.adult.displayName}</div>
                    <div className={styles.pickNarratorSub}>{personaCatalog.adult.description}</div>
                  </div>
                </div>
              </button>
              <button
                onClick={() => setSelectedPersona("preteen")}
                className={`${styles.pickNarratorOption} ${selectedPersona === "preteen" ? styles.pickNarratorOptionSelected : ""}`}
              >
                <div className={styles.pickNarratorWithAvatar}>
                  <div className={styles.pickNarratorAvatarWrap}>
                    <Image
                      src={personaCatalog.preteen.avatarSrc}
                      alt={personaCatalog.preteen.avatarAlt}
                      fill
                      className={styles.pickNarratorAvatar}
                    />
                  </div>
                  <div>
                    <div className={styles.pickRouteTitle}>{personaCatalog.preteen.displayName}</div>
                    <div className={styles.pickNarratorSub}>{personaCatalog.preteen.description}</div>
                  </div>
                </div>
              </button>
            </div>
            <div className={styles.pickSectionDivider} />
            <div className={styles.pickCopyBlock}>
              <h2 className={styles.pickHeading}>
                How long do you have in{" "}
                <button type="button" className={styles.pickHeadingCityLink} onClick={goHome}>
                  {selectedCityLabel}
                </button>
                ?
              </h2>
            </div>

            <div className={styles.pickRouteList}>
              {salemRoutes.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedRouteId(r.id)}
                  className={`${styles.pickRouteRow} ${selectedRouteId === r.id ? styles.pickRouteRowSelected : ""}`}
                >
                  <div className={styles.pickRouteMainWithIcon}>
                    <div className={styles.pickRouteIconCircle} aria-hidden="true">
                      <Image
                        src="/icons/person-walking.svg"
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
                        {r.durationLabel} • {r.stops.length} stops • {formatRouteMiles(getRouteMiles(r.stops))}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
              <button
                type="button"
                disabled
                aria-disabled="true"
                className={`${styles.pickRouteRow} ${styles.pickRouteRowDisabled}`}
              >
                <div className={styles.pickRouteMainWithIcon}>
                  <div className={styles.pickRouteIconCircle} aria-hidden="true">
                    <Image
                      src="/icons/car-front-fill.svg"
                      alt=""
                      width={24}
                      height={24}
                      className={styles.pickRouteWalkIcon}
                      aria-hidden="true"
                    />
                  </div>
                  <div className={styles.pickRouteMain}>
                    <div className={styles.pickRouteTitle}>City Drive Thru</div>
                    <div className={styles.pickRouteMeta}>Coming soon</div>
                  </div>
                </div>
              </button>
            </div>
            <div className={styles.pickSectionDivider} />

            <div className={styles.pickDurationStartWrap}>
              <button
                onClick={startTourFromSelection}
                disabled={!selectedRouteId || !selectedPersona}
                className={`${styles.landingCtaButton} ${styles.startTourButton}`}
              >
                Start Tour
              </button>
              <button
                onClick={() => setStep("buildMix")}
                className={styles.pickBuildMixButton}
              >
                Create your own mix
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
            <button onClick={closeRoutePicker} className={`${styles.mapBackButton} ${styles.mapBackButtonInverted} ${styles.pickCloseButtonMapMobile}`} aria-label="Close">
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
              <h2 className={styles.pickHeading}>Create your own mix of {selectedCityLabel}</h2>
            </div>

            <div className={styles.pickSectionLabel}>Transportation</div>
            <div className={styles.pickPersonaRow}>
              <button
                onClick={() => setTransportMode("walk")}
                className={`${styles.pickNarratorOption} ${transportMode === "walk" ? styles.pickNarratorOptionSelected : ""}`}
              >
                <div className={styles.pickRouteMainWithIcon}>
                  <div className={styles.pickRouteIconCircle} aria-hidden="true">
                    <Image
                      src="/icons/person-walking.svg"
                      alt=""
                      width={24}
                      height={24}
                      className={styles.pickRouteWalkIcon}
                      aria-hidden="true"
                    />
                  </div>
                  <div className={styles.pickRouteMain}>
                    <div className={styles.pickRouteTitle}>Walk</div>
                    <div className={styles.pickNarratorSub}>Curated walking route</div>
                  </div>
                </div>
              </button>
              <button
                onClick={() => setTransportMode("drive")}
                className={`${styles.pickNarratorOption} ${transportMode === "drive" ? styles.pickNarratorOptionSelected : ""}`}
              >
                <div className={styles.pickRouteMainWithIcon}>
                  <div className={styles.pickRouteIconCircle} aria-hidden="true">
                    <Image
                      src="/icons/car-front-fill.svg"
                      alt=""
                      width={24}
                      height={24}
                      className={styles.pickRouteWalkIcon}
                      aria-hidden="true"
                    />
                  </div>
                  <div className={styles.pickRouteMain}>
                    <div className={styles.pickRouteTitle}>Drive</div>
                    <div className={styles.pickNarratorSub}>City drive-through mix</div>
                  </div>
                </div>
              </button>
            </div>

            <div className={styles.pickSectionLabel}>Length of tour</div>
            <div className={styles.pickLengthRow}>
              {[15, 30, 60].map((min) => (
                <button
                  key={min}
                  onClick={() => setSelectedLengthMinutes(min)}
                  className={`${styles.pickLengthButton} ${selectedLengthMinutes === min ? styles.pickLengthButtonSelected : ""}`}
                >
                  {min} min
                </button>
              ))}
            </div>

            <div className={styles.pickSectionLabel}>Narrator</div>
            <div className={styles.pickPersonaRow}>
              <button
                onClick={() => setSelectedPersona("adult")}
                className={`${styles.pickNarratorOption} ${selectedPersona === "adult" ? styles.pickNarratorOptionSelected : ""}`}
              >
                <div className={styles.pickNarratorWithAvatar}>
                  <div className={styles.pickNarratorAvatarWrap}>
                    <Image
                      src={personaCatalog.adult.avatarSrc}
                      alt={personaCatalog.adult.avatarAlt}
                      fill
                      className={styles.pickNarratorAvatar}
                    />
                  </div>
                  <div>
                    <div className={styles.pickRouteTitle}>{personaCatalog.adult.displayName}</div>
                    <div className={styles.pickNarratorSub}>{personaCatalog.adult.description}</div>
                  </div>
                </div>
              </button>
              <button
                onClick={() => setSelectedPersona("preteen")}
                className={`${styles.pickNarratorOption} ${selectedPersona === "preteen" ? styles.pickNarratorOptionSelected : ""}`}
              >
                <div className={styles.pickNarratorWithAvatar}>
                  <div className={styles.pickNarratorAvatarWrap}>
                    <Image
                      src={personaCatalog.preteen.avatarSrc}
                      alt={personaCatalog.preteen.avatarAlt}
                      fill
                      className={styles.pickNarratorAvatar}
                    />
                  </div>
                  <div>
                    <div className={styles.pickRouteTitle}>{personaCatalog.preteen.displayName}</div>
                    <div className={styles.pickNarratorSub}>{personaCatalog.preteen.description}</div>
                  </div>
                </div>
              </button>
            </div>

            <div className={styles.pickSectionLabel}>
              Choose stops ({builderSelectedStops.length}/{maxStopsForSelection || 0} selected)
            </div>
            <div className={styles.pickLimitHint}>
              Max {maxStopsForSelection || 0} stops for {selectedLengthMinutes} min {transportMode} tour.
            </div>
            <div className={styles.buildMixLinkAddWrap}>
              <textarea
                value={linkBatchInput}
                onChange={(e) => setLinkBatchInput(e.target.value)}
                className={styles.buildMixLinkTextarea}
                placeholder="Paste Google Maps links, one per line"
                rows={4}
              />
              <button
                type="button"
                onClick={addStopsFromLinks}
                disabled={isResolvingLinks}
                className={styles.pickBuildMixButton}
              >
                {isResolvingLinks ? "Resolving links..." : "Add Stops from Links"}
              </button>
              {resolveSummary && (
                <div className={styles.buildMixLinkSummary}>
                  Added {resolveSummary.added}. Skipped duplicates {resolveSummary.skippedDuplicate}.
                  {resolveSummary.skippedLimit > 0 ? ` Reached max and skipped ${resolveSummary.skippedLimit}.` : ""}
                  {resolveSummary.failed.length > 0 ? ` Failed ${resolveSummary.failed.length} invalid/unreadable link(s).` : ""}
                </div>
              )}
            </div>
            <div className={styles.pickRouteList}>
              {buildMixDisplayStops.map((stop) => {
                const stopCoordKey = getStopCoordKey(stop);
                const active = builderSelectedStops.some(
                  (s) => s.id === stop.id || getStopCoordKey(s) === stopCoordKey
                );
                return (
                  <button
                    key={stop.id}
                    onClick={() => toggleBuilderStop(stop)}
                    className={`${styles.pickRouteRow} ${styles.pickRouteRowBuildMix} ${active ? styles.pickRouteRowSelected : ""}`}
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
                    <div className={styles.pickRouteMain}>
                      <div className={styles.pickRouteTitle}>{stop.title}</div>
                      <div className={styles.stopRating} aria-label="4 out of 5 stars">
                        <span className={styles.stopRatingFilled}>★</span>
                        <span className={styles.stopRatingFilled}>★</span>
                        <span className={styles.stopRatingFilled}>★</span>
                        <span className={styles.stopRatingFilled}>★</span>
                        <span className={styles.stopRatingEmpty}>★</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className={styles.pickDurationStartWrap}>
              <button
                onClick={startCustomMixGeneration}
                disabled={!selectionValidation.ok || !selectedPersona || isGeneratingMix}
                className={`${styles.landingCtaButton} ${styles.startTourButton}`}
              >
                Generate Tour
              </button>
            </div>
          </section>
          <section className={`${styles.pickImagePane} ${styles.buildMixImagePane}`}>
            <RouteMap
              stops={builderSelectedStops}
              currentStopIndex={0}
              myPos={myPos}
              cityCenter={selectedCityCenter}
              followCurrentStop={false}
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

      {step === "generating" && (
        <main className={styles.generatingLayout}>
          <video
            className={styles.generatingVideo}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            aria-hidden="true"
          >
            <source src="/images/marketing/ginger-walking-remix-v2.mp4" type="video/mp4" />
          </video>
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
                      onClick={generationJobKind === "preset" ? startTourFromSelection : startCustomMixGeneration}
                      disabled={isGeneratingMix}
                      className={styles.landingCtaButton}
                    >
                      Retry generation
                    </button>
                    <button
                      type="button"
                      onClick={() => setStep(generationJobKind === "preset" ? "pickDuration" : "buildMix")}
                      className={styles.pickBuildMixButton}
                    >
                      {generationJobKind === "preset" ? "Back to routes" : "Back to editor"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>
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
              View directions
            </a>
          </div>
          <div className={styles.rightRail}>
            <div className={styles.walkCard}>
              <div className={styles.walkMetaRow}>
                <Image
                  src="/icons/stars.svg"
                  alt=""
                  width={24}
                  height={24}
                  className={styles.walkNarratorIcon}
                  aria-hidden="true"
                />
                <div className={styles.walkNarrator}>
                  Narrated by {activePersonaDisplayName}
                </div>
              </div>
            <h1 className={styles.walkHeadline}>{route.title}</h1>
            <div className={styles.walkSubline}>
              <span>{connectedCount} {connectedCount === 1 ? "person" : "people"} connected</span>
              <span>{route.durationLabel}/{routeMilesLabel} walking</span>
            </div>

              <div className={styles.walkActionRow}>
                <button className={styles.pillButton} type="button" onClick={copyShareLink}>Share to...</button>
                <button
                  className={styles.pillButton}
                  type="button"
                  onClick={() => {
                    setReturnToWalkOnClose(true);
                    setStep("pickDuration");
                  }}
                >
                  Customize
                </button>
              </div>

              <div className={styles.stopList}>
                {stopList.map((stop, idx) => (
                  <button
                    key={stop.id}
                    onClick={() => void handleStopSelect(idx)}
                    className={`${styles.stopItem} ${stop.isActive ? styles.stopItemActive : ""}`}
                    type="button"
                  >
                    <div className={styles.stopThumbWrap}>
                      <Image src={stop.image} alt={stop.title} fill className={styles.stopThumb} />
                    </div>
                    <div className={styles.stopText}>
                      <div className={`${styles.stopTitle} ${stop.isActive ? styles.stopTitleActive : ""}`}>
                        {idx + 1}. {stop.title}
                      </div>
                      <div className={styles.stopSubtitle}>{stop.subtitle}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {currentStop && (
              <div className={styles.nowPlayingBar}>
                <audio ref={audioRef} preload="metadata" src={currentStopAudio} hidden />
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
                  <div className={styles.nowPlayingMeta}>
                    <button
                      type="button"
                      className={styles.nowPlayingTitleLink}
                      onClick={openScriptModal}
                    >
                      {currentStop.title}
                    </button>
                    <div className={styles.nowPlayingLinksRow}>
                      <div className={styles.nowPlayingSubtitle}>
                        {isGeneratingScriptForModal
                          ? "Generating script..."
                          : isGeneratingAudioForCurrentStop
                            ? "Generating audio..."
                            : hasCurrentAudio
                              ? `${formatAudioTime(audioTime)} / ${formatAudioTime(audioDuration)}`
                              : "Audio not generated yet"}
                      </div>
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
                  </div>
                  <button
                    className={styles.nowPlayingButton}
                    onClick={toggleAudio}
                    disabled={!hasCurrentAudio}
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
              </div>
            )}
            {isScriptModalOpen && (
              <div className={styles.scriptModalOverlay} role="dialog" aria-modal="true" aria-label="Narration script">
                <div className={styles.scriptModal}>
                  <button
                    type="button"
                    className={styles.scriptModalClose}
                    onClick={() => setIsScriptModalOpen(false)}
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

      {step !== "walk" && step !== "landing" && step !== "pickDuration" && (
        <footer className={styles.footer}>
          {jam ? `Jam: ${jam.id}` : "No jam loaded"}
        </footer>
      )}
    </div>
  );
}

"use client";
 
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { supabase } from "@/lib/supabaseClient";
import { getRouteById, salemRoutes, type Persona, type RouteDef } from "@/app/content/salemRoutes";
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
    status: "generating" | "ready" | "failed";
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
  status: "queued" | "generating_script" | "generating_audio" | "ready" | "failed";
  progress: number;
  message: string | null;
  error: string | null;
  jam_id: string;
  route_id: string;
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
const [isGeneratingMix, setIsGeneratingMix] = useState(false);
const [generationJobId, setGenerationJobId] = useState<string | null>(null);
const [generationProgress, setGenerationProgress] = useState(0);
const [generationStatusLabel, setGenerationStatusLabel] = useState("Queued");
const [generationMessage, setGenerationMessage] = useState("Queued");
const [customRoute, setCustomRoute] = useState<RouteDef | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();

  const [err, setErr] = useState<string | null>(null);
  const [jam, setJam] = useState<JamRow | null>(null);

  const [step, setStep] = useState<FlowStep>("landing");

  // For MVP: Salem-only. This just controls whether we use geolocation-derived distances.
  const [geoAllowed, setGeoAllowed] = useState<boolean | null>(null);
  const [myPos, setMyPos] = useState<{ lat: number; lng: number } | null>(null);

  const jamIdFromUrl = searchParams.get("jam");

  // Derive route + stop from jam
  const route: RouteDef | null = useMemo(
    () => customRoute ?? getRouteById(jam?.route_id ?? null),
    [customRoute, jam?.route_id]
  );
  const persona: Persona = (jam?.persona ?? "adult") as Persona;

  const currentStopIndex = useMemo(() => {
    const idx = jam?.current_stop ?? 0;
    if (!route) return 0;
    return clamp(idx, 0, route.stops.length - 1);
  }, [jam?.current_stop, route]);

  const currentStop = route ? route.stops[currentStopIndex] : null;
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
  async function createJam(routeId?: string, personaValue: Persona = "adult") {
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

    if (error) return setErr(error.message);

    setJam(data as JamRow);

    // Put it in URL like your existing flow
    router.replace(`/?jam=${data.id}`);

    if (!routeId) setStep("pickDuration");
    else setStep("walk");
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
    setStep("landing");
  }

  function getCustomRouteId(routeRef: string | null | undefined) {
    if (!routeRef?.startsWith("custom:")) return null;
    return routeRef.slice("custom:".length) || null;
  }

  function getGenerationStatusLabel(status: MixJobResponse["status"]) {
    if (status === "queued") return "Queued";
    if (status === "generating_script") return "Generating script";
    if (status === "generating_audio") return "Generating audio";
    if (status === "ready") return "Ready";
    return "Failed";
  }

  const loadCustomRoute = useCallback(async (routeRef: string) => {
    const customRouteId = getCustomRouteId(routeRef);
    if (!customRouteId) {
      setCustomRoute(null);
      return;
    }
    const res = await fetch(`/api/custom-routes/${customRouteId}`);
    if (!res.ok) throw new Error("Failed to load custom route");
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
          adult: s.audio_url_adult || "/audio/adult-01.mp3",
          preteen: s.audio_url_preteen || "/audio/kid-01.mp3",
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
  if (el) {
    try {
      await el.play();
    } catch {
      // autoplay might still be blocked in some cases; user can press play manually
    }
  }
}

  async function toggleAudio() {
    const el = audioRef.current;
    if (!el) return;
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

  // ---------- Step transitions ----------

  async function startTourFromSelection() {
    if (!selectedRouteId || !selectedPersona) return;

    if (!jam) {
      await createJam(selectedRouteId, selectedPersona);
      return;
    }

    await updateJam({
      route_id: selectedRouteId,
      persona: selectedPersona,
      current_stop: 0,
      completed_at: null,
    });
    setStep("walk");
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
      setGenerationProgress(0);
      setGenerationStatusLabel("Queued");
      setGenerationMessage("Queued");
      router.replace(`/?jam=${body.jamId}`);
      if (!jam || jam.id !== body.jamId) {
        await loadJamById(body.jamId);
      }
    } catch (e) {
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
    if (!jamIdFromUrl) {
      setJam(null);
      setCustomRoute(null);
      setStep("landing");
      return;
    }
    loadJamById(jamIdFromUrl);
  }, [jamIdFromUrl]);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const routeRef = jam?.route_id ?? null;
      if (!routeRef?.startsWith("custom:")) {
        setCustomRoute(null);
        return;
      }
      try {
        await loadCustomRoute(routeRef);
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "Failed to load custom route");
          setCustomRoute(null);
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [jam?.route_id, loadCustomRoute]);

  useEffect(() => {
    if (step !== "generating" || !generationJobId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/mix-jobs/${generationJobId}`, { cache: "no-store" });
        const body = (await res.json()) as MixJobResponse | { error?: string };
        if (!res.ok || !("status" in body)) {
          throw new Error(("error" in body && body.error) || "Failed to poll generation status");
        }
        if (cancelled) return;

        const nextProgress = Math.max(0, Math.min(100, Number(body.progress) || 0));
        setGenerationProgress(nextProgress);
        setGenerationStatusLabel(getGenerationStatusLabel(body.status));
        setGenerationMessage(body.message || "");

        if (body.status === "ready") {
          setGenerationJobId(null);
          await loadJamById(body.jam_id);
          return;
        }
        if (body.status === "failed") {
          setGenerationJobId(null);
          setErr(body.error || body.message || "Generation failed");
          setGenerationProgress(100);
          setGenerationStatusLabel("Failed");
          setGenerationMessage(body.error || body.message || "Generation failed");
        }
      } catch (e) {
        if (!cancelled) {
          setGenerationJobId(null);
          const message = e instanceof Error ? e.message : "Failed to poll generation status";
          setErr(message);
          setGenerationProgress(100);
          setGenerationStatusLabel("Failed");
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
  }, [step, generationJobId]);

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
    if (step !== "pickDuration") return;
    setSelectedRouteId(null);
    setSelectedPersona(null);
  }, [step]);

  useEffect(() => {
    if (step !== "buildMix") return;
    setBuilderSelectedStops([]);
    setSelectedPersona("adult");
    setTransportMode("walk");
    setSelectedLengthMinutes(30);
    setGenerationJobId(null);
    setGenerationProgress(0);
    setGenerationStatusLabel("Queued");
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
    if (step !== "walk") return;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [step]);

  const stopList = useMemo(() => {
    if (!route) return [];
    return route.stops.map((stop, idx) => {
      let subtitle = "At this location";
      if (idx < currentStopIndex) subtitle = "Visited";
      if (idx > currentStopIndex) {
        const prev = route.stops[idx - 1];
        const meters = haversineMeters(prev.lat, prev.lng, stop.lat, stop.lng);
        subtitle = `${estimateWalkMinutes(meters)} min walk away`;
      }
      return {
        id: stop.id,
        title: stop.title,
        image: stop.images[0] ?? "/images/salem/placeholder-01.png",
        subtitle,
        isActive: idx === currentStopIndex,
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
      {step !== "walk" && step !== "landing" && step !== "pickDuration" && (
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
              <h1 className={styles.landingHeading}>A mixtape for the streets.</h1>
              <p className={styles.landingCopy}>
                Create a custom audio tour of your town - stitched together like a mix you&apos;d give someone you care
                about. Because some places deserve more than directions.
              </p>
            </div>

            <div className={styles.landingPopular}>Popular mix tours:</div>

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
              </div>
              <span className={styles.landingArrow}>&#8250;</span>
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
                Create your own mix tour
              </button>
            </div>
          </section>

          <section className={styles.landingImagePane}>
            <div className={styles.landingImagePlaceholder} aria-hidden="true" />
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

    <button onClick={startStopNarration} className={styles.button}>
      Start stop
    </button>
  </div>
)}

      {/* PICK DURATION */}
      {step === "pickDuration" && (
        <main className={styles.pickLayout}>
          <section className={styles.pickInfo}>
            <button type="button" onClick={goHome} className={`${styles.brandLink} ${styles.landingBrand}`}>MixTours</button>
            <div className={styles.pickCopyBlock}>
              <h2 className={styles.pickHeading}>How long do you have in {selectedCityLabel}?</h2>
            </div>

            <div className={styles.pickRouteList}>
              {salemRoutes.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedRouteId(r.id)}
                  className={`${styles.pickRouteRow} ${selectedRouteId === r.id ? styles.pickRouteRowSelected : ""}`}
                >
                  <div className={styles.pickRouteMain}>
                    <div className={styles.pickRouteTitle}>{r.title}</div>
                    <div className={styles.pickRouteMeta}>
                      {r.durationLabel} • {r.stops.length} stops • {formatRouteMiles(getRouteMiles(r.stops))} walking
                    </div>
                  </div>
                  <div className={styles.pickRouteArrow}>&#8250;</div>
                </button>
              ))}
              <button
                type="button"
                disabled
                aria-disabled="true"
                className={`${styles.pickRouteRow} ${styles.pickRouteRowDisabled}`}
              >
                <div className={styles.pickRouteMain}>
                  <div className={styles.pickRouteTitle}>City Drive Thru</div>
                  <div className={styles.pickRouteMeta}>Driving route • Coming soon</div>
                </div>
                <div className={styles.pickRouteArrow}>-</div>
              </button>
            </div>

            <h2 className={`${styles.pickHeading} ${styles.pickNarratorHeading}`}>What narrator do you want?</h2>
            <div className={styles.pickPersonaRow}>
              <button
                onClick={() => setSelectedPersona("adult")}
                className={`${styles.pickNarratorOption} ${selectedPersona === "adult" ? styles.pickNarratorOptionSelected : ""}`}
              >
                <div className={styles.pickRouteTitle}>AI Historian</div>
                <div className={styles.pickNarratorSub}>Lorem ispum</div>
              </button>
              <button
                onClick={() => setSelectedPersona("preteen")}
                className={`${styles.pickNarratorOption} ${selectedPersona === "preteen" ? styles.pickNarratorOptionSelected : ""}`}
              >
                <div className={styles.pickRouteTitle}>AI Main Character</div>
                <div className={styles.pickNarratorSub}>Lorem ispum</div>
              </button>
            </div>

            <div className={styles.pickDurationStartWrap}>
              <button
                onClick={startTourFromSelection}
                disabled={!selectedRouteId || !selectedPersona}
                className={styles.landingCtaButton}
              >
                Start Tour
              </button>
              <button
                onClick={() => setStep("buildMix")}
                className={styles.pickBuildMixButton}
              >
                Build your own mix
              </button>
            </div>
          </section>

          <section className={styles.pickImagePane}>
            <RouteMap
              stops={selectedRoute ? selectedRoute.stops : []}
              currentStopIndex={0}
              myPos={myPos}
              cityCenter={selectedCityCenter}
            />
          </section>
        </main>
      )}

      {step === "buildMix" && (
        <main className={styles.pickLayout}>
          <section className={styles.pickInfo}>
            <button type="button" onClick={() => setStep("pickDuration")} className={`${styles.brandLink} ${styles.landingBrand}`}>
              MixTours
            </button>
            <div className={styles.pickCopyBlock}>
              <h2 className={styles.pickHeading}>Create your own mix in {selectedCityLabel}</h2>
            </div>

            <div className={styles.pickSectionLabel}>Transportation</div>
            <div className={styles.pickPersonaRow}>
              <button
                onClick={() => setTransportMode("walk")}
                className={`${styles.pickNarratorOption} ${transportMode === "walk" ? styles.pickNarratorOptionSelected : ""}`}
              >
                <div className={styles.pickRouteTitle}>Walk</div>
                <div className={styles.pickNarratorSub}>Curated walking route</div>
              </button>
              <button
                onClick={() => setTransportMode("drive")}
                className={`${styles.pickNarratorOption} ${transportMode === "drive" ? styles.pickNarratorOptionSelected : ""}`}
              >
                <div className={styles.pickRouteTitle}>Drive</div>
                <div className={styles.pickNarratorSub}>City drive-through mix</div>
              </button>
            </div>

            <div className={styles.pickSectionLabel}>Length of stay</div>
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
                <div className={styles.pickRouteTitle}>AI Historian</div>
                <div className={styles.pickNarratorSub}>Context and facts</div>
              </button>
              <button
                onClick={() => setSelectedPersona("preteen")}
                className={`${styles.pickNarratorOption} ${selectedPersona === "preteen" ? styles.pickNarratorOptionSelected : ""}`}
              >
                <div className={styles.pickRouteTitle}>AI Main Character</div>
                <div className={styles.pickNarratorSub}>Story-led and playful</div>
              </button>
            </div>

            <div className={styles.pickSectionLabel}>
              Choose stops ({builderSelectedStops.length}/{maxStopsForSelection || 0} selected)
            </div>
            <div className={styles.pickLimitHint}>
              Max {maxStopsForSelection || 0} stops for {selectedLengthMinutes} min {transportMode} tour.
            </div>
            <div className={styles.pickRouteList}>
              {availableStopsForCity.map((stop) => {
                const active = builderSelectedStops.some((s) => s.id === stop.id);
                return (
                  <button
                    key={stop.id}
                    onClick={() => toggleBuilderStop(stop)}
                    className={`${styles.pickRouteRow} ${active ? styles.pickRouteRowSelected : ""}`}
                  >
                    <div className={styles.pickRouteMain}>
                      <div className={styles.pickRouteTitle}>{stop.title}</div>
                      <div className={styles.pickRouteMeta}>{active ? "Selected" : "Tap to add stop"}</div>
                    </div>
                    <div className={styles.pickRouteArrow}>{active ? "✓" : "+"}</div>
                  </button>
                );
              })}
            </div>

            <div className={styles.pickDurationStartWrap}>
              <button
                onClick={startCustomMixGeneration}
                disabled={!selectionValidation.ok || !selectedPersona || isGeneratingMix}
                className={styles.landingCtaButton}
              >
                Generate & Start Tour
              </button>
            </div>
          </section>
          <section className={styles.pickImagePane}>
            <RouteMap
              stops={builderSelectedStops}
              currentStopIndex={0}
              myPos={myPos}
              cityCenter={selectedCityCenter}
            />
          </section>
        </main>
      )}

      {step === "generating" && (
        <main className={styles.pickLayout}>
          <section className={styles.pickInfo}>
            <button type="button" onClick={goHome} className={`${styles.brandLink} ${styles.landingBrand}`}>MixTours</button>
            <div className={styles.pickCopyBlock}>
              <h2 className={styles.pickHeading}>Generating your mix...</h2>
              <p className={styles.pickCopy}>
                We are creating AI narration and preparing audio for your selected stops. This can take a few moments.
              </p>
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
                      onClick={startCustomMixGeneration}
                      disabled={isGeneratingMix}
                      className={styles.landingCtaButton}
                    >
                      Retry generation
                    </button>
                    <button
                      type="button"
                      onClick={() => setStep("buildMix")}
                      className={styles.pickBuildMixButton}
                    >
                      Back to editor
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>
          <section className={styles.pickImagePane}>
            <div className={styles.pickImagePlaceholder} aria-hidden="true" />
          </section>
        </main>
      )}

      {/* WALK */}
      {step === "walk" && route && currentStop && (
        <main className={styles.walkLayout}>
          <div className={styles.mapHero}>
            <RouteMap stops={route.stops} currentStopIndex={currentStopIndex} myPos={myPos} />
            <button onClick={() => setStep("pickDuration")} className={styles.mapBackButton} aria-label="Back to routes">
              &#9001;
            </button>
            <a href={mapsUrl} target="_blank" rel="noreferrer" className={styles.mapViewButton}>
              View in maps
            </a>
          </div>
          <div className={styles.rightRail}>
            <div className={styles.walkCard}>
              <div className={styles.walkMetaRow}>
                <div className={styles.walkDot} />
                <div className={styles.walkNarrator}>
                  Narrated by {persona === "adult" ? "AI Historian" : "AI Main Character"}
                </div>
              </div>
            <h1 className={styles.walkHeadline}>{route.title}</h1>
            <div className={styles.walkSubline}>
              <span>{connectedCount} {connectedCount === 1 ? "person" : "people"} connected</span>
              <span>{route.durationLabel}/{routeMilesLabel} walking</span>
            </div>

              <div className={styles.walkActionRow}>
                <button className={styles.pillButton} type="button" onClick={copyShareLink}>Add people</button>
                <button className={styles.pillButton} type="button" onClick={() => setStep("pickDuration")}>Customize</button>
              </div>

              <div className={styles.stopList}>
                {stopList.map((stop, idx) => (
                  <button
                    key={stop.id}
                    onClick={() => updateJam({ current_stop: idx })}
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

            <div className={styles.nowPlayingBar}>
              <audio ref={audioRef} preload="metadata" src={currentStop.audio[persona]} hidden />
              <input
                type="range"
                min={0}
                max={audioDuration || 0}
                step={0.1}
                value={Math.min(audioTime, audioDuration || audioTime)}
                onChange={(e) => seekAudio(Number(e.target.value))}
                className={`${styles.audioSeek} ${styles.nowPlayingSeek}`}
              />
              <div className={styles.nowPlayingContent}>
                <div className={styles.nowPlayingMeta}>
                  <div className={styles.nowPlayingTitle}>{currentStop.title}</div>
                  <div className={styles.nowPlayingSubtitle}>
                    {formatAudioTime(audioTime)} / {formatAudioTime(audioDuration)}
                  </div>
                </div>
                <button
                  className={styles.nowPlayingButton}
                  onClick={toggleAudio}
                  aria-label={isPlaying ? "Pause current stop" : "Play current stop"}
                >
                  {isPlaying ? "❚❚" : "▶"}
                </button>
              </div>
            </div>
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

"use client";
 
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { supabase } from "@/lib/supabaseClient";
import { getRouteById, salemRoutes, type Persona, type RouteDef } from "@/app/content/salemRoutes";
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
  preset_id?: string | null;
};

type FlowStep = "landing" | "pickDuration" | "walk" | "end";

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
const audioBlockRef = useRef<HTMLDivElement | null>(null);
const [isPlaying, setIsPlaying] = useState(false);
const [audioTime, setAudioTime] = useState(0);
const [audioDuration, setAudioDuration] = useState(0);
const [connectedCount, setConnectedCount] = useState(0);

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
  const route: RouteDef | null = useMemo(() => getRouteById(jam?.route_id ?? null), [jam?.route_id]);
  const persona: Persona = (jam?.persona ?? "adult") as Persona;

  const currentStopIndex = useMemo(() => {
    const idx = jam?.current_stop ?? 0;
    if (!route) return 0;
    return clamp(idx, 0, route.stops.length - 1);
  }, [jam?.current_stop, route]);

  const currentStop = route ? route.stops[currentStopIndex] : null;
  const nextStop = route ? route.stops[currentStopIndex + 1] : null;
  const routeMilesLabel = useMemo(() => {
    if (!route) return "";
    return formatRouteMiles(getRouteMiles(route.stops));
  }, [route]);

  // ---------- Supabase: load jam ----------
  async function loadJamById(id: string) {
    setErr(null);
    const { data, error } = await supabase
      .from("jams")
      .select("id,host_name,route_id,persona,current_stop,completed_at,is_playing,position_ms,preset_id")
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
  async function createJam(routeId?: string) {
    setErr(null);

    // If routeId provided we can jump straight to walk; otherwise we’ll go to pickDuration.
    const insertRow: Partial<JamRow> & {
      host_name?: string;
      route_id?: string | null;
      persona?: Persona;
      current_stop?: number;
      is_playing?: boolean;
      position_ms?: number;
      preset_id?: string | null;
    } = {
      host_name: "Rob",
      route_id: routeId ?? null,
      persona: "adult",
      current_stop: 0,

      // legacy
      is_playing: false,
      position_ms: 0,
      preset_id: null,
    };

    const { data, error } = await supabase
      .from("jams")
      .insert(insertRow)
      .select("id,host_name,route_id,persona,current_stop,completed_at,is_playing,position_ms,preset_id")
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
      .select("id,host_name,route_id,persona,current_stop,completed_at,is_playing,position_ms,preset_id")
      .single();

    if (error) return setErr(error.message);
    setJam(data as JamRow);
  }

  async function copyShareLink() {
    if (!jam) return;
    await navigator.clipboard?.writeText(`${window.location.origin}/?jam=${jam.id}`);
  }

  // ---------- "Start stop” handler ----------
async function startStopNarration() {
  // scroll to audio block
  audioBlockRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

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
  function requestGeo() {
    setErr(null);

    if (!navigator.geolocation) {
      setGeoAllowed(false);
      setMyPos(null);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoAllowed(true);
        setMyPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        setGeoAllowed(false);
        setMyPos(null);
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  async function chooseRoute(routeId: RouteDef["id"]) {
    if (!jam) {
      // Create jam already tied to this route
      await createJam(routeId);
      return;
    }
    await updateJam({ route_id: routeId, current_stop: 0, completed_at: null });
    setStep("walk");
  }

  async function setPersona(nextPersona: Persona) {
    if (!jam) return;
    await updateJam({ persona: nextPersona });
  }

  async function nextStopAction() {
    if (!jam || !route) return;

    const lastIdx = route.stops.length - 1;
    if ((jam.current_stop ?? 0) >= lastIdx) {
      // finish
      await updateJam({ completed_at: new Date().toISOString() });
      setStep("end");
      return;
    }

    await updateJam({ current_stop: (jam.current_stop ?? 0) + 1 });
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
      setStep("landing");
      return;
    }
    loadJamById(jamIdFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jamIdFromUrl]);

// ---------- watchPosition ----------
  useEffect(() => {
  if (step !== "walk") return;
  if (!navigator.geolocation) return;
  if (!route || !currentStop) return;

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
}, [step, route?.id, currentStop?.id]);

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

  // ---------- Distance/ETA to next stop ----------
  const nextCue = useMemo(() => {
    if (!myPos || !nextStop) return null;
    const meters = haversineMeters(myPos.lat, myPos.lng, nextStop.lat, nextStop.lng);
    return {
      meters,
      dist: formatDistance(meters),
      mins: estimateWalkMinutes(meters),
    };
  }, [myPos, nextStop]);

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
    <div className={`${styles.container} ${step === "walk" ? styles.containerWide : ""}`}>
      {step !== "walk" && (
        <header className={styles.header}>
          <div>
            <div className={styles.brandTitle}>EchoJam</div>
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
        <main className={styles.section}>
          <h2 className={styles.landingTitle}>Your journey starts here</h2>
          <p className={styles.sectionBody}>
            Create a personalized audio tour — just for you. Answer a few quick questions and we&apos;ll map the stories, stops, and surprises that fit your pace.

          </p>

          <div className={styles.buttonRow}>
            <button onClick={() => createJam()} className={`${styles.button} ${styles.buttonLarge}`}>
              Start tour
            </button>
            <button onClick={() => requestGeo()} className={`${styles.button} ${styles.buttonLarge}`}>
              Enable location (optional)
            </button>
          </div>

          <div className={styles.hint}>
            If you already have a link, open it with <code>?jam=&lt;uuid&gt;</code>.
          </div>
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
        <main className={styles.section}>
          <h2 className={styles.sectionTitle}>How long do you have?</h2> 

          <div className={styles.routesGrid}>
            {salemRoutes.map((r) => (
              <button
                key={r.id}
                onClick={() => chooseRoute(r.id)}
                className={`${styles.button} ${styles.routeCard}`}
              >
                <div className={styles.routeDuration}>{r.durationLabel} • {formatRouteMiles(getRouteMiles(r.stops))} walking</div>
                <div className={styles.routeTitle}>{r.title}</div>
                <div className={styles.routeDescription}>{r.description}</div>
                <div className={styles.routeStops}>{r.stops.length} stops</div>
              </button>
            ))}
          </div>

          <div className={styles.narrationBlock}>

          <h2 className={styles.sectionTitle}>Narration (Settings):</h2>  
            <div className={styles.actionGroup}>
              <button
                onClick={() => jam && setPersona("adult")}
                disabled={!jam}
                className={`${styles.button} ${persona === "adult" ? styles.personaActive : styles.personaInactive}`}
              >
                Adult 
              </button>
              <button
                onClick={() => jam && setPersona("preteen")}
                disabled={!jam}
                className={`${styles.button} ${persona === "preteen" ? styles.personaActive : styles.personaInactive}`}
              >
                Preteen
              </button>
            </div>
          </div>
        </main>
      )}

      {/* WALK */}
      {step === "walk" && route && currentStop && (
        <main className={styles.walkLayout}>
          <div className={styles.mapHero}>
            <RouteMap stops={route.stops} currentStopIndex={currentStopIndex} myPos={myPos} />
            <button onClick={() => setStep("pickDuration")} className={styles.mapBackButton} aria-label="Back to routes">
              &#8592;
            </button>
            <a href={mapsUrl} target="_blank" rel="noreferrer" className={styles.mapViewButton}>
              View in maps
            </a>
          </div>
          <div className={styles.rightRail}>
            <div className={styles.walkCard}>
              <div className={styles.walkMetaRow}>
                <div className={styles.walkDot} />
                <div className={styles.walkNarrator}>{persona === "adult" ? "Adult Narrative" : "Preteen Narrative"}</div>
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
              <div>
                <div className={styles.nowPlayingTitle}>{currentStop.title}</div>
                <div className={styles.nowPlayingSubtitle}>
                  {nextStop && nextCue ? `Next: ${nextCue.mins} min walk away` : "At this location"}
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

            <div ref={audioBlockRef} className={`${styles.panel} ${styles.walkAudioPanel}`}>
              <audio ref={audioRef} preload="metadata" className={styles.audioPlayer} src={currentStop.audio[persona]} />
              <div className={styles.audioControls}>
                <button type="button" onClick={toggleAudio} className={styles.audioControlButton}>
                  {isPlaying ? "Pause" : "Play"}
                </button>
                <input
                  type="range"
                  min={0}
                  max={audioDuration || 0}
                  step={0.1}
                  value={Math.min(audioTime, audioDuration || audioTime)}
                  onChange={(e) => seekAudio(Number(e.target.value))}
                  className={styles.audioSeek}
                />
                <div className={styles.audioTime}>
                  {formatAudioTime(audioTime)} / {formatAudioTime(audioDuration)}
                </div>
              </div>
              <div className={styles.actionRow}>
                <span className={styles.blackText}>is this needed?</span>
                <button onClick={() => setPersona("adult")} className={`${styles.button} ${persona === "adult" ? styles.personaActive : styles.personaInactive}`}>Adult</button>
                <button onClick={() => setPersona("preteen")} className={`${styles.button} ${persona === "preteen" ? styles.personaActive : styles.personaInactive}`}>Preteen</button>
                <button onClick={() => nextStopAction()} className={`${styles.button} ${styles.buttonLarge}`}>
                  {currentStopIndex >= route.stops.length - 1 ? "Finish walk" : "Next stop"}
                </button>
                <button onClick={() => setStep("pickDuration")} className={`${styles.button} ${styles.buttonLarge}`}>Customize</button>
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

      {step !== "walk" && (
        <footer className={styles.footer}>
          {jam ? `Jam: ${jam.id}` : "No jam loaded"}
        </footer>
      )}
    </div>
  );
}

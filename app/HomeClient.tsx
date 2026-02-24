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

export default function HomeClient() {
  const [distanceToStopM, setDistanceToStopM] = useState<number | null>(null);
const [proximity, setProximity] = useState<"far" | "near" | "arrived">("far");
const audioRef = useRef<HTMLAudioElement | null>(null);
const audioBlockRef = useRef<HTMLDivElement | null>(null);

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

  // ---------- UI ----------
  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div>
          <div className={styles.brandTitle}>EchoJam — Salem</div>
          <div className={styles.mutedSmall}>
            {jam ? `Jam: ${jam.id}` : "No jam loaded"}
          </div>
        </div>

        <div className={styles.headerActions}>
          <button onClick={() => requestGeo()} className={styles.button}>
            {geoAllowed === true ? "Location: On" : geoAllowed === false ? "Location: Off" : "Use location"}
          </button>
          {jam && (
            <button
              onClick={() => {
                navigator.clipboard?.writeText(`${window.location.origin}/?jam=${jam.id}`);
              }}
              className={styles.button}
            >
              Copy share link
            </button>
          )}
        </div>
      </header>

      {err && (
        <div className={styles.error}>
          {err}
        </div>
      )}

      {/* LANDING */}
      {step === "landing" && (
        <main className={styles.section}>
          <h2 className={styles.landingTitle}>One City. Three Walks.</h2>
          <p className={styles.sectionBody}>
            Salem-only. Pre-written. Static. No AI. Stop-by-stop audio + images.
          </p>

          <div className={styles.buttonRow}>
            <button onClick={() => createJam()} className={`${styles.button} ${styles.buttonLarge}`}>
              Start a Salem walk
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
          <p className={styles.muted}>Pick a fixed route. No branching, no rerouting.</p>

          <div className={styles.routesGrid}>
            {salemRoutes.map((r) => (
              <button
                key={r.id}
                onClick={() => chooseRoute(r.id)}
                className={`${styles.button} ${styles.routeCard}`}
              >
                <div className={styles.routeDuration}>{r.durationLabel}</div>
                <div className={styles.routeTitle}>{r.title}</div>
                <div className={styles.routeDescription}>{r.description}</div>
                <div className={styles.routeStops}>{r.stops.length} stops</div>
              </button>
            ))}
          </div>

          <div className={styles.narrationBlock}>
            <div className={styles.narrationLabel}>Narration:</div>
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
        <main className={styles.section}>
          <div className={styles.walkHeader}>
            <div>
              <div className={styles.mutedSmall}>
                {route.durationLabel} — {route.title} • Stop {currentStopIndex + 1} of {route.stops.length}
              </div>
              <h2 className={styles.walkTitle}>{currentStop.title}</h2>
            </div>

            <div className={styles.actionGroup}>
              <button
                onClick={() => setPersona("adult")}
                className={`${styles.button} ${persona === "adult" ? styles.personaActive : styles.personaInactive}`}
              >
                Adult
              </button>
              <button
                onClick={() => setPersona("preteen")}
                className={`${styles.button} ${persona === "preteen" ? styles.personaActive : styles.personaInactive}`}
              >
                Preteen
              </button>
            </div>
          </div>

          {/* MAP placeholder area (you’ll replace with real map) */}
          <div className={styles.mapFrame}>
            <RouteMap stops={route.stops} currentStopIndex={currentStopIndex} myPos={myPos} />
          </div>

          {/* Audio */}
          <div ref={audioBlockRef} className={styles.panel}>
            <div className={styles.narrationLabel}>
              Narration ({persona === "adult" ? "Adult" : "Preteen"})
            </div>

            <audio
              ref={audioRef}
              controls
              preload="metadata"
              className={styles.audioPlayer}
              src={currentStop.audio[persona]}
            />

            {currentStop.text?.[persona] && (
              <p className={styles.narrationText}>{currentStop.text[persona]}</p>
            )}
          </div>
          {/* Images */}
          <div className={styles.imagesGrid}>
            {currentStop.images.slice(0, 2).map((src) => (
              <div key={src} className={styles.imageCard}>
                <div className={styles.imageFrame}>
                  <Image src={src} alt={currentStop.title} fill className={styles.image} />
                </div>
              </div>
            ))}
          </div>

          {/* Walk to next */}
          <div className={styles.panel}>
            <div className={styles.nextTitle}>Walk to next stop</div>

            {!nextStop && <div className={`${styles.spacedTop} ${styles.lightMuted}`}>This is the final stop.</div>}

            {nextStop && (
              <div className={`${styles.spacedTop} ${styles.semiMuted}`}>
                Next: <b>{nextStop.title}</b>
                <div className={`${styles.spacedTop} ${styles.muted}`}>
                  {myPos && nextCue ? (
                    <>
                      About <b>{nextCue.dist}</b> • ~<b>{nextCue.mins} min</b> on foot
                    </>
                  ) : (
                    <>Follow the map markers to the next stop.</>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className={styles.actionRow}>
            <button onClick={() => nextStopAction()} className={`${styles.button} ${styles.buttonLarge}`}>
              {currentStopIndex >= route.stops.length - 1 ? "Finish walk" : "Next stop"}
            </button>
            <button onClick={() => setStep("pickDuration")} className={`${styles.button} ${styles.buttonLarge}`}>
              Change route
            </button>
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
              onClick={() => {
                if (!jam) return;
                navigator.clipboard?.writeText(`${window.location.origin}/?jam=${jam.id}`);
              }}
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
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "../lib/supabaseClient";
import { Howl } from "howler";

type Jam = {
  id: string;
  host_name: string | null;
  is_playing: boolean;
  position_ms: number;
  audio_parent_url: string | null;
  audio_kid_url: string | null;
};

const DEMO_PARENT_AUDIO =
  "https://www2.cs.uic.edu/~i101/SoundFiles/StarWars60.wav"; // replace with your mp3
const DEMO_KID_AUDIO =
  "https://www2.cs.uic.edu/~i101/SoundFiles/CantinaBand60.wav"; // replace with your mp3

export default function HomeClient() {
  const search = useSearchParams();

  const [jam, setJam] = useState<Jam | null>(null);
  const [jamInput, setJamInput] = useState("");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Persona (stored locally per device)
  const [persona, setPersona] = useState<"kid" | "parent">("parent");

  // Audio (Howler)
  const howlRef = useRef<Howl | null>(null);
  const loadedSrcRef = useRef<string | null>(null);

  // Heartbeat for host to publish position_ms
  const heartbeatRef = useRef<number | null>(null);

  // Load persona from localStorage on first mount
  useEffect(() => {
    const saved = localStorage.getItem("echojam_persona");
    if (saved === "kid" || saved === "parent") setPersona(saved);
  }, []);

  // Persist persona changes
  useEffect(() => {
    localStorage.setItem("echojam_persona", persona);
  }, [persona]);

  function getPersonaSrc(j: Jam | null): string | null {
    if (!j) return null;
    return persona === "parent" ? j.audio_parent_url : j.audio_kid_url;
  }

  function ensureHowl(src: string) {
    if (loadedSrcRef.current === src && howlRef.current) return;

    // unload old
    if (howlRef.current) {
      howlRef.current.stop();
      howlRef.current.unload();
      howlRef.current = null;
      loadedSrcRef.current = null;
    }

    // load new
    howlRef.current = new Howl({
      src: [src],
      html5: true, // better streaming behavior on mobile
    });
    loadedSrcRef.current = src;
  }

  function getPositionMs(): number {
    const h = howlRef.current;
    if (!h) return 0;
    const s = h.seek();
    return typeof s === "number" ? Math.floor(s * 1000) : 0;
  }

  function seekMs(ms: number) {
    const h = howlRef.current;
    if (!h) return;
    h.seek(Math.max(0, ms) / 1000);
  }

  function playLocal() {
    howlRef.current?.play();
  }

  function pauseLocal() {
    howlRef.current?.pause();
  }

  async function loadJamById(id: string) {
    setErr(null);
    const { data, error } = await supabase.from("jams").select("*").eq("id", id).single();
    if (error) return setErr(error.message);
    setJam(data as Jam);
  }

  async function createJam() {
    setErr(null);

    const { data, error } = await supabase
      .from("jams")
      .insert({
        host_name: "Rob",
        is_playing: false,
        position_ms: 0,
        audio_parent_url: DEMO_PARENT_AUDIO,
        audio_kid_url: DEMO_KID_AUDIO,
      })
      .select("*")
      .single();

    if (error) return setErr(error.message);

    const created = data as Jam;
    setJam(created);

    const url = `${window.location.origin}/?jam=${created.id}`;
    setShareUrl(url);
    window.history.replaceState(null, "", `/?jam=${created.id}`);
    try {
      await navigator.clipboard.writeText(url);
    } catch {}
  }

  async function joinJam() {
    const id = jamInput.trim();
    if (!id) return;
    window.history.replaceState(null, "", `/?jam=${id}`);
    setShareUrl(`${window.location.origin}/?jam=${id}`);
    await loadJamById(id);
  }

  // HOST controls: update jam state
  async function hostPlay() {
    if (!jam) return;
    const pos = getPositionMs();
    // optimistic
    setJam({ ...jam, is_playing: true, position_ms: pos });

    const { error } = await supabase
      .from("jams")
      .update({ is_playing: true, position_ms: pos })
      .eq("id", jam.id);

    if (error) setErr(error.message);
  }

  async function hostPause() {
    if (!jam) return;
    const pos = getPositionMs();
    // optimistic
    setJam({ ...jam, is_playing: false, position_ms: pos });

    const { error } = await supabase
      .from("jams")
      .update({ is_playing: false, position_ms: pos })
      .eq("id", jam.id);

    if (error) setErr(error.message);
  }

  // Auto-join from ?jam=
  useEffect(() => {
    const id = search.get("jam");
    if (!id) return;

    setJamInput(id);
    setShareUrl(`${window.location.origin}/?jam=${id}`);

    if (!jam || jam.id !== id) {
      void loadJamById(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Realtime subscription
  useEffect(() => {
    if (!jam?.id) return;

    const channel = supabase
      .channel(`jam:${jam.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "jams", filter: `id=eq.${jam.id}` },
        (payload) => setJam(payload.new as Jam)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [jam?.id]);

  // Load correct audio when jam/persona changes
  useEffect(() => {
    if (!jam) return;

    const src = getPersonaSrc(jam);
    if (!src) return;

    ensureHowl(src);

    // Apply shared position immediately
    seekMs(jam.position_ms || 0);

    // Apply play state
    if (jam.is_playing) playLocal();
    else pauseLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jam?.id, jam?.audio_parent_url, jam?.audio_kid_url, persona]);

  // Follow remote changes: play/pause + drift correction
  useEffect(() => {
    if (!jam) return;

    const src = getPersonaSrc(jam);
    if (!src) return;

    ensureHowl(src);

    const localPos = getPositionMs();
    const target = jam.position_ms || 0;
    const drift = Math.abs(target - localPos);

    // If drift is large, snap to the shared position
    if (drift > 900) {
      seekMs(target);
    }

    if (jam.is_playing) playLocal();
    else pauseLocal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jam?.is_playing, jam?.position_ms]);

  // Host heartbeat: while playing, publish position every ~3 seconds
  useEffect(() => {
    if (!jam?.id) return;

    // Clear existing
    if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);

    heartbeatRef.current = window.setInterval(async () => {
      if (!jam.is_playing) return;
      const pos = getPositionMs();

      await supabase.from("jams").update({ position_ms: pos }).eq("id", jam.id);
    }, 3000);

    return () => {
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    };
  }, [jam?.id, jam?.is_playing]);

  return (
    <main style={{ padding: 40, maxWidth: 720 }}>
      <h1>EchoJam</h1>

      {/* Persona selector */}
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 14, opacity: 0.7 }}>Persona (this device)</div>
        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <button
            onClick={() => setPersona("parent")}
            style={{
              background: persona === "parent" ? "black" : "#eee",
              color: persona === "parent" ? "white" : "black",
              padding: "6px 12px",
              borderRadius: 6,
            }}
          >
            Parent
          </button>
          <button
            onClick={() => setPersona("kid")}
            style={{
              background: persona === "kid" ? "black" : "#eee",
              color: persona === "kid" ? "white" : "black",
              padding: "6px 12px",
              borderRadius: 6,
            }}
          >
            Kid
          </button>
        </div>
      </div>

      {!jam && (
        <>
          <div style={{ marginTop: 20 }}>
            <button onClick={createJam}>Create Jam (with demo audio)</button>
          </div>

          <div style={{ marginTop: 20 }}>
            <input
              placeholder="Paste Jam ID (or open a ?jam= link)"
              value={jamInput}
              onChange={(e) => setJamInput(e.target.value)}
              style={{ width: 420, maxWidth: "100%" }}
            />
            <button onClick={joinJam} style={{ marginLeft: 10 }}>
              Join Jam
            </button>
          </div>
        </>
      )}

      {jam && (
        <>
          <p style={{ marginTop: 16 }}>
            Jam: <code>{jam.id}</code>
          </p>

          <p style={{ marginTop: 10 }}>
            Viewing as: <b>{persona.toUpperCase()}</b>
          </p>

          <p>
            State: <b>{jam.is_playing ? "PLAYING" : "PAUSED"}</b>
          </p>

          <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
            <button onClick={hostPlay}>Play (updates jam)</button>
            <button onClick={hostPause}>Pause (updates jam)</button>
          </div>

          {shareUrl && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Share link:</div>
              <div style={{ wordBreak: "break-all" }}>{shareUrl}</div>
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <button
              onClick={() => {
                setJam(null);
                setJamInput("");
                setShareUrl(null);
                setErr(null);
                window.history.replaceState(null, "", "/");
              }}
            >
              Leave Jam
            </button>
          </div>
        </>
      )}

      {err && <p style={{ color: "red", marginTop: 16 }}>Error: {err}</p>}
    </main>
  );
}
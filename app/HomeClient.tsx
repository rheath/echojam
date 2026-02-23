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
  preset_id: string | null;
};

// ✅ Add presets here (match your hosted paths)
const PRESETS: Record<
  string,
  { name: string; parentUrl: string; kidUrl: string }
> = {
  salem: {
    name: "Salem Night Walk",
    parentUrl: "https://echojam.idrawcircles.com/audio/adult-01.mp3",
    kidUrl: "https://echojam.idrawcircles.com/audio/kid-01.mp3",
  },
  bedtime: {
    name: "Bedtime Trail",
    parentUrl: "https://echojam.idrawcircles.com/audio/adult-02.mp3",
    kidUrl: "https://echojam.idrawcircles.com/audio/kid-02.mp3",
  },
}; 

export default function HomeClient() {
  const search = useSearchParams();

  const [jam, setJam] = useState<Jam | null>(null);
  const [jamInput, setJamInput] = useState("");
  const [shareUrl, setShareUrl] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  const [persona, setPersona] = useState<"kid" | "parent">("parent");
  const [selectedPresetId, setSelectedPresetId] = useState<string>("salem");

  // Howler (typed any to avoid TS drama on host)
  const howlRef = useRef<any>(null);
  const loadedSrcRef = useRef<string | null>(null);

  // Persona persistence
  useEffect(() => {
    const saved = localStorage.getItem("echojam_persona");
    if (saved === "kid" || saved === "parent") setPersona(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem("echojam_persona", persona);
  }, [persona]);

  function updateShareUrl(id: string) {
    const url = `${window.location.origin}/?jam=${id}`;
    setShareUrl(url);
  }

  function getJamPreset(j: Jam | null) {
    if (!j?.preset_id) return null;
    return PRESETS[j.preset_id] ?? null;
  }

  function getPersonaSrc(j: Jam | null): string | null {
    const preset = getJamPreset(j);
    if (!preset) return null;
    return persona === "parent" ? preset.parentUrl : preset.kidUrl;
  }

  function ensureHowl(src: string) {
    if (loadedSrcRef.current === src && howlRef.current) return;

    if (howlRef.current) {
      howlRef.current.stop();
      howlRef.current.unload();
      howlRef.current = null;
      loadedSrcRef.current = null;
    }

    howlRef.current = new Howl({
      src: [src],
      html5: true,
    });
    loadedSrcRef.current = src;
  }

  async function loadJamById(id: string) {
    setErr(null);

    const { data, error } = await supabase
      .from("jams")
      .select("id,host_name,is_playing,position_ms,preset_id")
      .eq("id", id)
      .single();

    if (error) return setErr(error.message);

    const loaded = data as Jam;
    setJam(loaded);
    setJamInput(id);
    updateShareUrl(id);
    window.history.replaceState(null, "", `/?jam=${id}`);
  }

  async function createJam() {
    setErr(null);

    const presetId = selectedPresetId;

    const { data, error } = await supabase
      .from("jams")
      .insert({
        host_name: "Rob",
        is_playing: false,
        position_ms: 0,
        preset_id: presetId,
      })
      .select("id,host_name,is_playing,position_ms,preset_id")
      .single();

    if (error) return setErr(error.message);

    const created = data as Jam;
    setJam(created);

    updateShareUrl(created.id);
    window.history.replaceState(null, "", `/?jam=${created.id}`);

    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/?jam=${created.id}`
      );
    } catch {}
  }

  async function joinJam() {
    const id = jamInput.trim();
    if (!id) return;
    await loadJamById(id);
  }

  async function togglePlay() {
    if (!jam) return;

    const src = getPersonaSrc(jam);
    if (!src) {
      setErr("This jam has no valid preset_id. Create a new jam with a preset.");
      return;
    }

    const newState = !jam.is_playing;
    setJam({ ...jam, is_playing: newState }); // optimistic

    const { error } = await supabase
      .from("jams")
      .update({ is_playing: newState })
      .eq("id", jam.id);

    if (error) setErr(error.message);
  }

  // Auto-join from ?jam=
  useEffect(() => {
    const id = search.get("jam");
    if (!id) return;
    if (jam?.id === id) return;
    void loadJamById(id);
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

  // Apply correct audio + play/pause
  useEffect(() => {
    if (!jam) return;

    const src = getPersonaSrc(jam);
    if (!src) return;

    ensureHowl(src);

    if (jam.is_playing) howlRef.current?.play();
    else howlRef.current?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jam?.is_playing, jam?.preset_id, persona]);

  const presetForJam = getJamPreset(jam);

  return (
    <main style={{ padding: 40, maxWidth: 720 }}>
      <h1>EchoJam</h1>

      {/* Persona selector */}
      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 14, opacity: 0.7 }}>Persona (this device)</div>
        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <button onClick={() => setPersona("parent")}>Parent</button>
          <button onClick={() => setPersona("kid")}>Kid</button>
        </div>
        <div style={{ marginTop: 6 }}>
          Current: <b>{persona.toUpperCase()}</b>
        </div>
      </div>

      {!jam && (
        <>
          {/* Preset picker */}
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 14, opacity: 0.7 }}>Choose a preset</div>
            <select
              value={selectedPresetId}
              onChange={(e) => setSelectedPresetId(e.target.value)}
              style={{ marginTop: 6, padding: 6 }}
            >
              {Object.entries(PRESETS).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginTop: 18 }}>
            <button onClick={createJam}>Create Jam</button>
          </div>

          <div style={{ marginTop: 16 }}>
            <input
              placeholder="Paste Jam ID"
              value={jamInput}
              onChange={(e) => setJamInput(e.target.value)}
              style={{ width: 420, maxWidth: "100%" }}
            />
            <button onClick={joinJam} style={{ marginLeft: 10 }}>
              Join
            </button>
          </div>
        </>
      )}

      {jam && (
        <>
          <p style={{ marginTop: 16 }}>
            Jam: <code>{jam.id}</code>
          </p>

          <p>
            Preset: <b>{presetForJam ? presetForJam.name : jam.preset_id ?? "—"}</b>
          </p>

          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Share link:</div>
            <div style={{ wordBreak: "break-all" }}>{shareUrl}</div>
            <button
              style={{ marginTop: 8 }}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(shareUrl);
                } catch {}
              }}
            >
              Copy Link
            </button>
          </div>

          <div style={{ marginTop: 18 }}>
            <button onClick={togglePlay}>{jam.is_playing ? "Pause" : "Play"}</button>
          </div>

          <div style={{ marginTop: 18 }}>
            <button
              onClick={() => {
                setJam(null);
                setJamInput("");
                setShareUrl("");
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
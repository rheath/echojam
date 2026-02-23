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

export default function HomeClient() {
  const search = useSearchParams();

  const [jam, setJam] = useState<Jam | null>(null);
  const [jamInput, setJamInput] = useState("");
  const [shareUrl, setShareUrl] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  const [persona, setPersona] = useState<"kid" | "parent">("parent");

  // Howler instance (typed as any to avoid TS type issues on your host)
  const howlRef = useRef<any>(null);
  const loadedSrcRef = useRef<string | null>(null);

  // Persona persistence (device-local)
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

  function getPersonaSrc(j: Jam | null): string | null {
    if (!j) return null;
    return persona === "parent" ? j.audio_parent_url : j.audio_kid_url;
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

    const { data, error } = await supabase.from("jams").select("*").eq("id", id).single();
    if (error) {
      setErr(error.message);
      return;
    }

    setJam(data as Jam);
    setJamInput(id);
    updateShareUrl(id);
    window.history.replaceState(null, "", `/?jam=${id}`);
  }

  async function createJam() {
    setErr(null);

    const { data, error } = await supabase
      .from("jams")
      .insert({
        host_name: "Rob",
        is_playing: false,
        position_ms: 0,
        audio_parent_url: null,
        audio_kid_url: null,
      })
      .select("*")
      .single();

    if (error) {
      setErr(error.message);
      return;
    }

    const created = data as Jam;
    setJam(created);

    updateShareUrl(created.id);
    window.history.replaceState(null, "", `/?jam=${created.id}`);

    try {
      await navigator.clipboard.writeText(`${window.location.origin}/?jam=${created.id}`);
    } catch {
      // clipboard permissions may block; we still show the link
    }
  }

  async function joinJam() {
    const id = jamInput.trim();
    if (!id) return;
    await loadJamById(id);
  }

  async function uploadFileForJam(file: File, jamId: string, kind: "parent" | "kid") {
    // Store per-jam folder so files are naturally grouped
    const safeName = file.name.replace(/\s+/g, "_");
    const filePath = `${jamId}/${kind}-${Date.now()}-${safeName}`;

    const { error: uploadErr } = await supabase.storage.from("audio").upload(filePath, file, {
      upsert: false,
      contentType: file.type || "audio/mpeg",
    });

    if (uploadErr) throw uploadErr;

    const { data } = supabase.storage.from("audio").getPublicUrl(filePath);
    return data.publicUrl;
  }

  async function handleUpload(kind: "parent" | "kid", file: File) {
    if (!jam) return;

    try {
      setErr(null);
      const url = await uploadFileForJam(file, jam.id, kind);

      const patch = kind === "parent" ? { audio_parent_url: url } : { audio_kid_url: url };

      const { data, error } = await supabase
        .from("jams")
        .update(patch)
        .eq("id", jam.id)
        .select("*")
        .single();

      if (error) {
        setErr(error.message);
        return;
      }

      setJam(data as Jam);
    } catch (e: any) {
      setErr(e?.message ?? "Upload failed");
    }
  }

  // Play/pause updates jam (simple sync)
  async function togglePlay() {
    if (!jam) return;

    // Must have an audio URL for this persona (or at least one) to play anything
    const src = getPersonaSrc(jam);
    if (!src) {
      setErr("Upload audio for this persona first (Parent and/or Kid).");
      return;
    }

    const newState = !jam.is_playing;

    // optimistic
    setJam({ ...jam, is_playing: newState });

    const { error } = await supabase.from("jams").update({ is_playing: newState }).eq("id", jam.id);
    if (error) setErr(error.message);
  }

  // Auto-join from ?jam=
  useEffect(() => {
    const id = search.get("jam");
    if (!id) return;

    // Avoid reloading if already loaded
    if (jam?.id === id) return;

    void loadJamById(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Realtime subscription for this jam
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

  // When jam changes (or persona changes), ensure the right audio loads and play state applies
  useEffect(() => {
    if (!jam) return;

    const src = getPersonaSrc(jam);
    if (!src) return; // allow jam to exist without audio yet

    ensureHowl(src);

    if (jam.is_playing) {
      howlRef.current?.play();
    } else {
      howlRef.current?.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jam?.is_playing, jam?.audio_parent_url, jam?.audio_kid_url, persona]);

  return (
    <main style={{ padding: 40 }}>
      <h1>EchoJam</h1>

      {!jam && (
        <>
          <button onClick={createJam}>Create Jam</button>

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

          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Share link:</div>
            <div style={{ wordBreak: "break-all" }}>{shareUrl}</div>
            <button
              style={{ marginTop: 8 }}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(shareUrl);
                } catch {
                  // ignore
                }
              }}
            >
              Copy Link
            </button>
          </div>

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

          <div style={{ marginTop: 18 }}>
            <div>
              <label>Upload Parent Audio: </label>
              <input
                type="file"
                accept="audio/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleUpload("parent", f);
                }}
              />
            </div>

            <div style={{ marginTop: 10 }}>
              <label>Upload Kid Audio: </label>
              <input
                type="file"
                accept="audio/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleUpload("kid", f);
                }}
              />
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
              Parent URL: {jam.audio_parent_url ? "✅ set" : "—"} <br />
              Kid URL: {jam.audio_kid_url ? "✅ set" : "—"}
            </div>
          </div>

          <div style={{ marginTop: 20 }}>
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
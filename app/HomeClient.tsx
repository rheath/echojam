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
  const [err, setErr] = useState<string | null>(null);
  const [persona, setPersona] = useState<"kid" | "parent">("parent");

  const howlRef = useRef<any>(null);

  useEffect(() => {
    const saved = localStorage.getItem("echojam_persona");
    if (saved === "kid" || saved === "parent") setPersona(saved);
  }, []);

  useEffect(() => {
    localStorage.setItem("echojam_persona", persona);
  }, [persona]);

  function getSrc(j: Jam | null) {
    if (!j) return null;
    return persona === "parent" ? j.audio_parent_url : j.audio_kid_url;
  }

  function loadAudio(src: string) {
    if (howlRef.current) {
      howlRef.current.stop();
      howlRef.current.unload();
    }

    howlRef.current = new Howl({
      src: [src],
      html5: true,
    });
  }

  async function uploadFile(file: File) {
    const filePath = `${Date.now()}-${file.name}`;

    const { error } = await supabase.storage
      .from("audio")
      .upload(filePath, file);

    if (error) throw error;

    const { data } = supabase.storage
      .from("audio")
      .getPublicUrl(filePath);

    return data.publicUrl;
  }

  async function createJam() {
    const { data, error } = await supabase
      .from("jams")
      .insert({
        host_name: "Rob",
        is_playing: false,
        position_ms: 0,
      })
      .select("*")
      .single();

    if (error) return setErr(error.message);

    setJam(data as Jam);
  }

  async function handleUpload(type: "parent" | "kid", file: File) {
    if (!jam) return;

    try {
      const url = await uploadFile(file);

      const updateField =
        type === "parent" ? { audio_parent_url: url } : { audio_kid_url: url };

      const { error } = await supabase
        .from("jams")
        .update(updateField)
        .eq("id", jam.id)
        .select("*")
        .single();

      if (error) return setErr(error.message);

      await loadJam(jam.id);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function loadJam(id: string) {
    const { data, error } = await supabase
      .from("jams")
      .select("*")
      .eq("id", id)
      .single();

    if (error) return setErr(error.message);
    setJam(data as Jam);
  }

  async function togglePlay() {
    if (!jam) return;

    const newState = !jam.is_playing;

    await supabase
      .from("jams")
      .update({ is_playing: newState })
      .eq("id", jam.id);
  }

  useEffect(() => {
    if (!jam) return;

    const src = getSrc(jam);
    if (!src) return;

    loadAudio(src);

    if (jam.is_playing) howlRef.current.play();
    else howlRef.current.pause();
  }, [jam?.is_playing, persona]);

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

  return (
    <main style={{ padding: 40 }}>
      <h1>EchoJam</h1>

      <div>
        <button onClick={createJam}>Create Jam</button>
      </div>

      {jam && (
        <>
          <p>Jam: {jam.id}</p>

          <div>
            <label>Upload Parent Audio:</label>
            <input
              type="file"
              accept="audio/*"
              onChange={(e) =>
                e.target.files &&
                handleUpload("parent", e.target.files[0])
              }
            />
          </div>

          <div>
            <label>Upload Kid Audio:</label>
            <input
              type="file"
              accept="audio/*"
              onChange={(e) =>
                e.target.files &&
                handleUpload("kid", e.target.files[0])
              }
            />
          </div>

          <div style={{ marginTop: 20 }}>
            <button onClick={() => setPersona("parent")}>Parent</button>
            <button onClick={() => setPersona("kid")}>Kid</button>
          </div>

          <div style={{ marginTop: 20 }}>
            <button onClick={togglePlay}>
              {jam.is_playing ? "Pause" : "Play"}
            </button>
          </div>
        </>
      )}

      {err && <p style={{ color: "red" }}>{err}</p>}
    </main>
  );
}
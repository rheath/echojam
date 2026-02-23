"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "../lib/supabaseClient";

type Jam = {
  id: string;
  host_name: string | null;
  is_playing: boolean;
  position_ms: number;
};

export default function Home() {
  const search = useSearchParams();

  const [jam, setJam] = useState<Jam | null>(null);
  const [jamInput, setJamInput] = useState("");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function loadJamById(id: string) {
    setErr(null);

    const { data, error } = await supabase
      .from("jams")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      setErr(error.message);
      return;
    }

    setJam(data as Jam);
  }

  async function createJam() {
    setErr(null);

    const { data, error } = await supabase
      .from("jams")
      .insert({ host_name: "Rob", is_playing: false, position_ms: 0 })
      .select("*")
      .single();

    if (error) {
      setErr(error.message);
      return;
    }

    const created = data as Jam;
    setJam(created);

    // Create a shareable link and copy it to clipboard
    const url = `${window.location.origin}/?jam=${created.id}`;
    setShareUrl(url);

    // Update URL in-place so refresh keeps you in the jam
    window.history.replaceState(null, "", `/?jam=${created.id}`);

    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard can fail (permissions). That's OK; we still show the link.
    }
  }

  async function joinJam() {
    const id = jamInput.trim();
    if (!id) return;

    // Update URL so you can share/refresh
    window.history.replaceState(null, "", `/?jam=${id}`);
    setShareUrl(`${window.location.origin}/?jam=${id}`);

    await loadJamById(id);
  }

  async function setPlaying(isPlaying: boolean) {
    if (!jam) return;

    // optimistic UI
    setJam({ ...jam, is_playing: isPlaying });

    const { error } = await supabase
      .from("jams")
      .update({ is_playing: isPlaying })
      .eq("id", jam.id);

    if (error) setErr(error.message);
  }

  // Auto-join if URL has ?jam=<id>
  useEffect(() => {
    const id = search.get("jam");
    if (!id) return;

    setJamInput(id);
    setShareUrl(`${window.location.origin}/?jam=${id}`);

    // Only auto-load if we aren't already in a jam or it's a different jam
    if (!jam || jam.id !== id) {
      void loadJamById(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Realtime subscription to jam updates
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
    <main style={{ padding: 40, maxWidth: 720 }}>
      <h1>EchoJam</h1>

      {!jam && (
        <>
          <button onClick={createJam}>Create Jam</button>

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

          <p>
            State: <b>{jam.is_playing ? "PLAYING" : "PAUSED"}</b>
          </p>

          <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
            <button onClick={() => setPlaying(true)}>Play</button>
            <button onClick={() => setPlaying(false)}>Pause</button>
          </div>

          {shareUrl && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Share link (copied to clipboard if allowed):</div>
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
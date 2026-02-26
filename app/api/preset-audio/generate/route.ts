import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRouteById, type Persona } from "@/app/content/salemRoutes";
import { ensureCanonicalStopForPreset, upsertRouteStopMapping } from "@/lib/canonicalStops";
import {
  getSwitchConfig,
  shouldRegenerateAudio,
  synthesizeSpeechWithOpenAI,
  toNullableTrimmed,
  uploadNarrationAudio,
} from "@/lib/mixGeneration";
import { buildPresetStopsWithOverview, normalizePresetCity } from "@/lib/presetOverview";

type Body = {
  routeId: string;
  stopId: string;
  persona: Persona;
  city?: "salem" | "boston" | "concord";
};

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const route = getRouteById(body.routeId);
    if (!route) return NextResponse.json({ error: "Unknown preset route" }, { status: 404 });
    const city = normalizePresetCity(body.city);
    const stops = buildPresetStopsWithOverview(route.stops, city);
    const stopIndex = stops.findIndex((s) => s.id === body.stopId);
    if (stopIndex < 0) return NextResponse.json({ error: "Unknown stop for preset route" }, { status: 404 });

    const stop = stops[stopIndex];
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY is required." }, { status: 500 });

    const admin = getAdmin();
    const canonical = await ensureCanonicalStopForPreset(admin, city, {
      id: stop.id,
      title: stop.title,
      lat: stop.lat,
      lng: stop.lng,
      image: stop.image,
    });
    await upsertRouteStopMapping(admin, "preset", route.id, stop.id, canonical.id, stopIndex);

    const switchConfig = await getSwitchConfig();
    const forceAudio = shouldRegenerateAudio(switchConfig.mode);
    const replayUrl = toNullableTrimmed(switchConfig.replay_audio[stop.id]?.[body.persona]);

    const { data: current } = await admin
      .from("canonical_stop_assets")
      .select("script,audio_url,status,error")
      .eq("canonical_stop_id", canonical.id)
      .eq("persona", body.persona)
      .maybeSingle();

    const script = toNullableTrimmed(current?.script);
    if (!script) {
      return NextResponse.json({ error: "Script not generated yet for this stop/persona." }, { status: 400 });
    }

    let audioUrl = !forceAudio ? toNullableTrimmed(current?.audio_url) : null;
    if (replayUrl) audioUrl = replayUrl;
    if (audioUrl) {
      return NextResponse.json({ audioUrl, reused: true });
    }

    const audioBytes = await synthesizeSpeechWithOpenAI(apiKey, body.persona, script);
    audioUrl = toNullableTrimmed(await uploadNarrationAudio(audioBytes, `preset-${route.id}`, body.persona, stop.id));
    if (!audioUrl) {
      return NextResponse.json({ error: "Generated audio URL was empty" }, { status: 500 });
    }

    await admin.from("canonical_stop_assets").upsert(
      {
        canonical_stop_id: canonical.id,
        persona: body.persona,
        script,
        audio_url: audioUrl,
        status: "ready",
        error: null,
      },
      { onConflict: "canonical_stop_id,persona" }
    );

    return NextResponse.json({ audioUrl, reused: false });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate preset audio" },
      { status: 500 }
    );
  }
}
